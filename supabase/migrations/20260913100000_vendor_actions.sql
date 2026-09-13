-- What the vendor can do to a licence: issue it, withdraw it, move it.
--
-- Three verbs, and the third is the one that needs care. "Transfer" in this
-- product used to mean a credit the restaurant spent by activating elsewhere.
-- The vendor asked for something plainer: withdraw the licence this restaurant
-- has and hand it a new one, in a single action, with both halves recorded.
-- That is what `transfer_license` does.
--
-- Nothing is ever deleted. "Delete" marks a licence withdrawn and releases the
-- device holding it; the row, its activations and its audit lines all stay,
-- because the question a vendor eventually asks is "what happened to that
-- restaurant's first licence", and a deleted row cannot answer it.

alter table licenses add column if not exists deleted_at     timestamptz;
alter table licenses add column if not exists deleted_reason text;
-- The licence this one replaced, so a chain of moves reads as a chain.
alter table licenses add column if not exists transfer_of    text references licenses(license_id);

create index if not exists idx_licenses_live on licenses(restaurant_id) where deleted_at is null;

/* ------------------------------------------------------------ withdraw */

create or replace function delete_license(
  p_license_id text,
  p_reason     text,
  p_actor      text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_license licenses%rowtype;
  v_live    activations%rowtype;
begin
  if auth.uid() is not null and not is_vendor() then
    return jsonb_build_object('error', 'FORBIDDEN', 'status', 403,
      'detail', 'only the vendor may withdraw a licence');
  end if;

  select * into v_license from licenses where license_id = p_license_id;
  if not found then
    return jsonb_build_object('error', 'NOT_FOUND', 'status', 404, 'detail', 'no such licence');
  end if;
  if v_license.deleted_at is not null then
    return jsonb_build_object('error', 'CONFLICT', 'status', 409,
      'detail', 'this licence has already been withdrawn');
  end if;

  -- The binding goes with it: the device that held this licence no longer
  -- holds anything, and the next activation of anything is a fresh one.
  select * into v_live
    from activations
   where license_id = v_license.license_id and released_at is null;
  if found then
    update activations
       set released_at = now(), release_reason = coalesce(nullif(p_reason, ''), 'licence withdrawn')
     where id = v_live.id;
  end if;

  update licenses
     set status = 'REVOKED',
         deleted_at = now(),
         deleted_reason = nullif(p_reason, ''),
         updated_at = now()
   where license_id = v_license.license_id;

  insert into audit_log (actor, action, license_id, restaurant_id, detail)
  values (p_actor, 'license.withdrawn', v_license.license_id, v_license.restaurant_id,
          jsonb_build_object('reason', p_reason,
                             'releasedDevice', v_live.device_fingerprint));

  return jsonb_build_object('ok', true, 'licenseId', v_license.license_id,
    'releasedDevice', v_live.device_fingerprint);
end;
$$;

/* ------------------------------------------------------------- move it */

create or replace function transfer_license(
  p_license_id   text,
  p_new_key_hash text,
  p_new_key_hint text,
  p_reason       text,
  p_actor        text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old   licenses%rowtype;
  v_live  activations%rowtype;
  v_new   text;
  v_n     integer;
begin
  if auth.uid() is not null and not is_vendor() then
    return jsonb_build_object('error', 'FORBIDDEN', 'status', 403,
      'detail', 'only the vendor may move a licence');
  end if;

  select * into v_old from licenses where license_id = p_license_id;
  if not found then
    return jsonb_build_object('error', 'NOT_FOUND', 'status', 404, 'detail', 'no such licence');
  end if;
  if v_old.deleted_at is not null then
    return jsonb_build_object('error', 'CONFLICT', 'status', 409,
      'detail', 'this licence has already been withdrawn; issue a new one instead');
  end if;

  select * into v_live
    from activations
   where license_id = v_old.license_id and released_at is null;
  if found then
    update activations
       set released_at = now(), release_reason = 'moved to a replacement licence'
     where id = v_live.id;
  end if;

  update licenses
     set status = 'TRANSFERRED',
         deleted_at = now(),
         deleted_reason = coalesce(nullif(p_reason, ''), 'moved to a replacement licence'),
         updated_at = now()
   where license_id = v_old.license_id;

  v_n := next_counter('license');
  v_new := 'LIC-' || to_char(now(), 'YYYY') || '-' || lpad(v_n::text, 6, '0');

  insert into licenses (license_id, restaurant_id, key_hash, key_hint, license_type,
                        status, transfer_of, transfer_count)
  values (v_new, v_old.restaurant_id, p_new_key_hash, p_new_key_hint, v_old.license_type,
          'PENDING', v_old.license_id, v_old.transfer_count + 1);

  insert into transfers (id, license_id, from_fingerprint, to_fingerprint, reason,
                         fee_reference, performed_by)
  values ('TRF-' || replace(gen_random_uuid()::text, '-', ''), v_new,
          v_live.device_fingerprint, null,
          coalesce(nullif(p_reason, ''), 'moved by the vendor'), null, p_actor);

  -- Both halves, so the log reads as one event from either end.
  insert into audit_log (actor, action, license_id, restaurant_id, detail)
  values (p_actor, 'license.moved_out', v_old.license_id, v_old.restaurant_id,
          jsonb_build_object('reason', p_reason, 'replacedBy', v_new,
                             'releasedDevice', v_live.device_fingerprint)),
         (p_actor, 'license.moved_in', v_new, v_old.restaurant_id,
          jsonb_build_object('reason', p_reason, 'replaces', v_old.license_id,
                             'keyHint', p_new_key_hint));

  return jsonb_build_object('ok', true, 'licenseId', v_new, 'replaces', v_old.license_id,
    'releasedDevice', v_live.device_fingerprint);
end;
$$;

/* -------------------------------------------------- what the console reads */

/*
 * One call for the whole list.
 *
 * The console could read the tables directly — the policies allow it — but a
 * list of restaurants each needing its licences, its live device and its last
 * activation is four round trips per row from a browser that may be on a phone
 * on mobile data. This is one.
 */
create or replace function vendor_overview()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(entry order by entry->>'restaurantId' desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'restaurantId', r.restaurant_id,
      'name', r.name,
      'contactName', r.contact_name,
      'contactPhone', r.contact_phone,
      'contactEmail', r.contact_email,
      'country', r.country,
      'notes', r.notes,
      'createdAt', r.created_at,
      'licenses', coalesce((
        select jsonb_agg(jsonb_build_object(
          'licenseId', l.license_id,
          'keyHint', l.key_hint,
          'status', l.status,
          'licenseType', l.license_type,
          'transferCount', l.transfer_count,
          'transferOf', l.transfer_of,
          'activatedAt', l.activated_at,
          'appVersion', l.app_version,
          'deletedAt', l.deleted_at,
          'deletedReason', l.deleted_reason,
          'createdAt', l.created_at,
          'device', (
            select jsonb_build_object('fingerprint', a.device_fingerprint,
                                      'label', a.device_label,
                                      'activatedAt', a.activated_at)
              from activations a
             where a.license_id = l.license_id and a.released_at is null
             limit 1)
        ) order by l.created_at desc)
          from licenses l where l.restaurant_id = r.restaurant_id), '[]'::jsonb)
    ) as entry
    from restaurants r
  ) rows
  where is_vendor() or auth.uid() is null;
$$;

/** Everything that ever happened to one licence, in order. */
create or replace function license_history(p_license_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'activations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'device', a.device_fingerprint, 'label', a.device_label,
        'appVersion', a.app_version, 'activatedAt', a.activated_at,
        'releasedAt', a.released_at, 'releaseReason', a.release_reason,
        'clientIp', a.client_ip) order by a.activated_at desc)
      from activations a where a.license_id = p_license_id), '[]'::jsonb),
    'log', coalesce((
      select jsonb_agg(jsonb_build_object(
        'at', g.at, 'actor', g.actor, 'action', g.action, 'detail', g.detail,
        'clientIp', g.client_ip) order by g.at desc)
      from audit_log g where g.license_id = p_license_id), '[]'::jsonb)
  )
  where is_vendor() or auth.uid() is null;
$$;

/* ------------------------------------------------------------- grants */

revoke all on function delete_license(text, text, text) from public, anon;
revoke all on function transfer_license(text, text, text, text, text) from public, anon;
revoke all on function vendor_overview() from public, anon;
revoke all on function license_history(text) from public, anon;

grant execute on function delete_license(text, text, text) to service_role, authenticated;
grant execute on function transfer_license(text, text, text, text, text) to service_role, authenticated;
grant execute on function vendor_overview() to service_role, authenticated;
grant execute on function license_history(text) to service_role, authenticated;
