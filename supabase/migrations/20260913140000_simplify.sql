-- Three verbs: issue, activate, cancel.
--
-- The previous shape had a fourth — transfer — that moved a licence and
-- withdrew the old one in a single action, and a soft delete that kept
-- withdrawn rows forever. Both are gone. A restaurant that needs to move to a
-- new machine is issued another licence like anybody else, and the vendor
-- decides for themselves whether the old one should go.
--
-- Two deliberate reversals from the original design, both asked for and both
-- with a real cost, written down here so the cost is not forgotten:
--
-- The key is stored. It used to be hashed on arrival and shown to the vendor
-- exactly once, so that a stolen database gave up no keys at all. The vendor
-- needs to read a key back — a customer rings up having lost theirs, and
-- "nobody can recover it, including me" is a bad answer to give somebody who
-- has paid. So the key is kept. A database leak now leaks keys; what limits
-- the damage is that a key is bound to one machine on activation and the
-- vendor can delete any of them from the console in a second.
--
-- Deleting means deleting. A cancelled licence leaves the database entirely,
-- rather than being marked gone — that is what "remove it from the database"
-- means, and the vendor's console keeps its own copy of what it deleted. The
-- audit line stays, because it names what happened rather than reproducing it.

/* ------------------------------------------------------- reshape licences */

alter table licenses add column if not exists license_key text;
alter table licenses add column if not exists device_fingerprint text;
alter table licenses add column if not exists device_label text;

-- Transfers were a concept; they are not one any more.
drop function if exists transfer_license(text, text, text, text, text);
alter table licenses drop column if exists transfer_of;

-- Activations were a table because a licence could move between machines and
-- the history mattered. A licence now binds to one machine and is deleted
-- rather than moved, so the binding lives on the licence itself.
drop function if exists license_history(text);
drop table if exists transfers;
drop table if exists activations;

/* ------------------------------------- attempts, counted on the server's clock */

/*
 * Five tries, then a day's wait — and the day is the server's.
 *
 * A restaurant needs the internet to activate, which means the count can live
 * where the clock cannot be argued with. Counting locally would put the limit
 * behind a device setting: turn the phone's date forward and the wait is over.
 * Here, changing the clock changes nothing at all.
 */
create table if not exists activation_attempts (
  id          bigint generated always as identity primary key,
  fingerprint text not null,
  at          timestamptz not null default now(),
  key_hint    text,
  client_ip   text
);

create index if not exists idx_attempts_recent on activation_attempts(fingerprint, at desc);

alter table activation_attempts enable row level security;
grant all privileges on activation_attempts to service_role;

/* --------------------------------------------------------------- issuing */

create or replace function issue_license(
  p_restaurant_id   text,
  p_restaurant_name text,
  p_contact_name    text,
  p_contact_phone   text,
  p_contact_email   text,
  p_country         text,
  p_notes           text,
  p_license_type    text,
  p_key             text,
  p_key_hash        text,
  p_key_hint        text,
  p_actor           text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_restaurant restaurants%rowtype;
  v_rid text;
  v_lid text;
  v_n   integer;
begin
  if auth.uid() is not null and not is_vendor() then
    return jsonb_build_object('error', 'FORBIDDEN', 'status', 403,
      'detail', 'only the vendor may issue a licence');
  end if;

  if p_restaurant_id is not null then
    select * into v_restaurant from restaurants where restaurant_id = p_restaurant_id;
    if not found then
      return jsonb_build_object('error', 'NOT_FOUND', 'status', 404, 'detail', 'restaurant not found');
    end if;
    v_rid := v_restaurant.restaurant_id;
  else
    if coalesce(trim(p_restaurant_name), '') = '' then
      return jsonb_build_object('error', 'VALIDATION', 'status', 400,
        'detail', 'a restaurant name is required');
    end if;
    v_n := next_counter('restaurant');
    v_rid := 'REST-' || lpad(v_n::text, 6, '0');
    insert into restaurants (restaurant_id, name, contact_name, contact_phone,
                             contact_email, country)
    values (v_rid, trim(p_restaurant_name), p_contact_name, p_contact_phone,
            p_contact_email, p_country);
  end if;

  v_n := next_counter('license');
  v_lid := 'LIC-' || to_char(now(), 'YYYY') || '-' || lpad(v_n::text, 6, '0');

  insert into licenses (license_id, restaurant_id, license_key, key_hash, key_hint,
                        license_type, status, notes)
  values (v_lid, v_rid, p_key, p_key_hash, p_key_hint,
          coalesce(p_license_type, 'PERPETUAL'), 'PENDING', p_notes);

  insert into audit_log (actor, action, license_id, restaurant_id, detail)
  values (p_actor, 'license.issued', v_lid, v_rid,
          jsonb_build_object('keyHint', p_key_hint, 'notes', p_notes));

  return jsonb_build_object('ok', true, 'licenseId', v_lid, 'restaurantId', v_rid);
end;
$$;

/* ------------------------------------------------------------ activating */

create or replace function activate_license(
  p_key_hash      text,
  p_fingerprint   text,
  p_label         text,
  p_app_version   text,
  p_restaurant_id text,
  p_client_ip     text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_license    licenses%rowtype;
  v_restaurant restaurants%rowtype;
  v_tries      integer;
  v_oldest     timestamptz;
begin
  -- The wait is checked before the key is even looked at, so a locked-out
  -- device learns nothing by guessing.
  select count(*), min(at) into v_tries, v_oldest
    from activation_attempts
   where fingerprint = p_fingerprint and at > now() - interval '24 hours';

  if v_tries >= 5 then
    return jsonb_build_object('error', 'RATE_LIMITED', 'status', 429,
      'detail', 'too many attempts; this device must wait',
      'retryAfterSeconds',
        greatest(0, extract(epoch from (v_oldest + interval '24 hours' - now()))::integer));
  end if;

  select * into v_license from licenses where key_hash = p_key_hash;
  if not found then
    insert into activation_attempts (fingerprint, client_ip) values (p_fingerprint, p_client_ip);
    return jsonb_build_object('error', 'LICENSE_UNKNOWN_KEY', 'status', 404,
      'detail', 'no licence matches this key',
      'attemptsLeft', greatest(0, 5 - (v_tries + 1)));
  end if;

  select * into v_restaurant from restaurants where restaurant_id = v_license.restaurant_id;

  if v_license.status = 'REVOKED' then
    insert into activation_attempts (fingerprint, key_hint, client_ip)
    values (p_fingerprint, v_license.key_hint, p_client_ip);
    return jsonb_build_object('error', 'LICENSE_REVOKED', 'status', 403,
      'detail', 'this licence has been revoked',
      'attemptsLeft', greatest(0, 5 - (v_tries + 1)));
  end if;

  -- Already on another machine. There is no transfer: the restaurant cancels
  -- it from the machine that holds it, or the vendor issues another licence.
  if v_license.device_fingerprint is not null
     and v_license.device_fingerprint <> p_fingerprint then
    insert into activation_attempts (fingerprint, key_hint, client_ip)
    values (p_fingerprint, v_license.key_hint, p_client_ip);
    return jsonb_build_object('error', 'LICENSE_ALREADY_ACTIVE_ELSEWHERE', 'status', 409,
      'detail', 'this licence is in use on another computer',
      'attemptsLeft', greatest(0, 5 - (v_tries + 1)));
  end if;

  if p_restaurant_id is not null and p_restaurant_id <> v_license.restaurant_id then
    insert into activation_attempts (fingerprint, key_hint, client_ip)
    values (p_fingerprint, v_license.key_hint, p_client_ip);
    return jsonb_build_object('error', 'LICENSE_RESTAURANT_MISMATCH', 'status', 409,
      'detail', 'this licence belongs to a different restaurant',
      'attemptsLeft', greatest(0, 5 - (v_tries + 1)));
  end if;

  update licenses
     set status = 'ACTIVE',
         device_fingerprint = p_fingerprint,
         device_label = nullif(p_label, ''),
         app_version = coalesce(nullif(p_app_version, ''), app_version),
         activated_at = coalesce(activated_at, now()),
         updated_at = now()
   where license_id = v_license.license_id;

  -- A key that worked clears the slate: the limit exists to slow guessing, and
  -- this device has just proved it was not guessing.
  delete from activation_attempts where fingerprint = p_fingerprint;

  insert into audit_log (actor, action, license_id, restaurant_id, detail, client_ip)
  values ('installation', 'license.activated', v_license.license_id, v_license.restaurant_id,
          jsonb_build_object('deviceFingerprint', p_fingerprint, 'deviceLabel', p_label,
                             'appVersion', p_app_version),
          p_client_ip);

  return jsonb_build_object(
    'ok', true,
    'licenseId', v_license.license_id,
    'licenseType', v_license.license_type,
    'restaurantId', v_license.restaurant_id,
    'restaurantName', coalesce(v_restaurant.name, ''),
    'activationId', v_license.license_id,
    'transferCount', 0
  );
end;
$$;

/* -------------------------------------------------------------- cancelling */

/*
 * The restaurant giving its licence back.
 *
 * Pressed on the machine that holds it, and it takes the licence out of the
 * database rather than marking it spent — after this the vendor's console
 * shows nothing, and the restaurant asks for a new one.
 */
create or replace function cancel_license(
  p_key_hash    text,
  p_fingerprint text,
  p_client_ip   text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_license licenses%rowtype;
begin
  select * into v_license from licenses where key_hash = p_key_hash;
  if not found then
    -- Already gone. Saying so plainly lets the installation clear itself out
    -- rather than sit holding a licence the vendor deleted last week.
    return jsonb_build_object('ok', true, 'alreadyGone', true);
  end if;

  if v_license.device_fingerprint is not null
     and v_license.device_fingerprint <> p_fingerprint then
    return jsonb_build_object('error', 'LICENSE_DEVICE_MISMATCH', 'status', 403,
      'detail', 'this computer does not hold that licence');
  end if;

  delete from licenses where license_id = v_license.license_id;

  insert into audit_log (actor, action, license_id, restaurant_id, detail, client_ip)
  values ('installation', 'license.cancelled', v_license.license_id, v_license.restaurant_id,
          jsonb_build_object('deviceFingerprint', p_fingerprint,
                             'keyHint', v_license.key_hint), p_client_ip);

  return jsonb_build_object('ok', true, 'licenseId', v_license.license_id);
end;
$$;

/* ---------------------------------------------- the vendor deleting one */

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
begin
  if auth.uid() is not null and not is_vendor() then
    return jsonb_build_object('error', 'FORBIDDEN', 'status', 403,
      'detail', 'only the vendor may delete a licence');
  end if;

  select * into v_license from licenses where license_id = p_license_id;
  if not found then
    return jsonb_build_object('error', 'NOT_FOUND', 'status', 404, 'detail', 'no such licence');
  end if;

  delete from licenses where license_id = p_license_id;

  insert into audit_log (actor, action, license_id, restaurant_id, detail)
  values (p_actor, 'license.deleted', v_license.license_id, v_license.restaurant_id,
          jsonb_build_object('reason', p_reason, 'keyHint', v_license.key_hint,
                             'wasOn', v_license.device_fingerprint));

  return jsonb_build_object('ok', true, 'licenseId', v_license.license_id);
end;
$$;

/* --------------------------------------------------------- what is there */

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
          -- Readable on purpose: a customer who has lost their key rings the
          -- vendor, and the vendor has to be able to read it back to them.
          'key', l.license_key,
          'keyHint', l.key_hint,
          'status', l.status,
          'notes', l.notes,
          'device', l.device_fingerprint,
          'deviceLabel', l.device_label,
          'activatedAt', l.activated_at,
          'appVersion', l.app_version,
          'createdAt', l.created_at
        ) order by l.created_at desc)
          from licenses l where l.restaurant_id = r.restaurant_id), '[]'::jsonb)
    ) as entry
    from restaurants r
  ) rows
  where is_vendor() or auth.uid() is null;
$$;

/* ------------------------------------------------------------- grants */

revoke all on function issue_license(text, text, text, text, text, text, text, text, text, text, text, text) from public, anon;
revoke all on function cancel_license(text, text, text) from public, anon;
revoke all on function activate_license(text, text, text, text, text, text) from public, anon;
revoke all on function delete_license(text, text, text) from public, anon;
revoke all on function vendor_overview() from public, anon;

grant execute on function issue_license(text, text, text, text, text, text, text, text, text, text, text, text) to service_role, authenticated;
grant execute on function cancel_license(text, text, text) to service_role;
grant execute on function activate_license(text, text, text, text, text, text) to service_role;
grant execute on function delete_license(text, text, text) to service_role, authenticated;
grant execute on function vendor_overview() to service_role, authenticated;
