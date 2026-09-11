-- The licence rules, in the database rather than in front of it.
--
-- Activation is not one write. It looks a licence up, decides whether this
-- machine may have it, charges a transfer if the hardware genuinely moved,
-- records the binding, updates the licence and writes an audit line. Done as
-- six separate calls from an Edge Function, a failure halfway through leaves a
-- licence that is half-activated — and the invariant these rules exist to
-- protect, that a licence is live on exactly one machine, is already enforced
-- one layer down by `idx_activations_live`.
--
-- So the decision lives here, in one transaction, next to that index. The Edge
-- Function's remaining job is the one thing Postgres cannot do: sign the
-- certificate with a key the database has never seen.
--
-- These functions speak in JSON rather than raising exceptions, because the
-- caller has to turn a refusal into a specific error code and HTTP status for
-- a restaurant owner staring at an activation screen, and parsing that back
-- out of a Postgres error message would be a worse contract than returning it.

/* ---------------------------------------------------------- activation */

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
  v_license     licenses%rowtype;
  v_restaurant  restaurants%rowtype;
  v_live        activations%rowtype;
  v_last_device text;
  v_previous    text;
  v_transferred boolean := false;
  v_count       integer;
  v_activation  activations%rowtype;
  v_id          text;
begin
  select * into v_license from licenses where key_hash = p_key_hash;
  if not found then
    -- Being specific here is a support win, not a security loss: the key's
    -- checksum already makes blind guessing hopeless.
    return jsonb_build_object('error', 'LICENSE_UNKNOWN_KEY', 'status', 404,
      'detail', 'no licence matches this key');
  end if;

  select * into v_restaurant from restaurants where restaurant_id = v_license.restaurant_id;
  if not found then
    return jsonb_build_object('error', 'INTERNAL', 'status', 500,
      'detail', 'licence has no restaurant');
  end if;

  if v_license.status = 'REVOKED' then
    return jsonb_build_object('error', 'LICENSE_REVOKED', 'status', 403,
      'detail', 'this licence has been revoked');
  end if;

  -- An installation that already knows its identity must not be able to attach
  -- a different restaurant's licence to its data.
  if p_restaurant_id is not null and p_restaurant_id <> v_license.restaurant_id then
    return jsonb_build_object('error', 'LICENSE_RESTAURANT_MISMATCH', 'status', 409,
      'detail', 'this licence belongs to a different restaurant');
  end if;

  select * into v_live
    from activations
   where license_id = v_license.license_id and released_at is null;

  if found and v_live.device_fingerprint = p_fingerprint then
    -- The same machine re-activating: refresh the binding, charge nothing.
    update activations
       set released_at = now(), release_reason = 'reactivated on the same device'
     where id = v_live.id;
  elsif found then
    return jsonb_build_object('error', 'LICENSE_ALREADY_ACTIVE_ELSEWHERE', 'status', 409,
      'detail', 'this licence is active on another device; deactivate it first');
  elsif v_license.status <> 'PENDING' then
    /*
     * No live binding, and this licence has been activated before. A transfer
     * fee is for *moving hardware*, so it is charged only when this is a
     * different machine from the one that last held the licence. Coming back
     * to the same PC — after a change of mind, or after the vendor revoked and
     * reinstated — must be free, or the restaurant is billed for nothing.
     */
    select device_fingerprint into v_last_device
      from activations
     where license_id = v_license.license_id
     order by activated_at desc
     limit 1;

    if v_last_device is distinct from p_fingerprint then
      if v_license.transfer_credits <= 0 then
        return jsonb_build_object('error', 'LICENSE_TRANSFER_NOT_PAID', 'status', 402,
          'detail', 'moving this licence to a new device requires a licence transfer');
      end if;
      v_transferred := true;
    end if;
  end if;

  select device_fingerprint into v_previous
    from activations
   where license_id = v_license.license_id and device_fingerprint <> p_fingerprint
   order by activated_at desc
   limit 1;

  v_id := 'ACT-' || replace(gen_random_uuid()::text, '-', '');
  insert into activations (id, license_id, device_fingerprint, device_label, app_version, client_ip)
  values (v_id, v_license.license_id, p_fingerprint, nullif(p_label, ''),
          nullif(p_app_version, ''), p_client_ip)
  returning * into v_activation;

  v_count := v_license.transfer_count + (case when v_transferred then 1 else 0 end);

  update licenses
     set status           = 'ACTIVE',
         activated_at     = coalesce(v_license.activated_at, v_activation.activated_at),
         app_version      = coalesce(nullif(p_app_version, ''), v_license.app_version),
         transfer_count   = v_count,
         transfer_credits = v_license.transfer_credits - (case when v_transferred then 1 else 0 end),
         updated_at       = now()
   where license_id = v_license.license_id;

  if v_transferred then
    insert into transfers (id, license_id, from_fingerprint, to_fingerprint, reason,
                           fee_reference, performed_by)
    values ('TRF-' || replace(gen_random_uuid()::text, '-', ''), v_license.license_id,
            v_previous, p_fingerprint, 'device transfer', null, 'activation');
  end if;

  insert into audit_log (actor, action, license_id, restaurant_id, detail, client_ip)
  values ('installation',
          case when v_transferred then 'license.transferred' else 'license.activated' end,
          v_license.license_id, v_license.restaurant_id,
          jsonb_build_object('deviceFingerprint', p_fingerprint, 'deviceLabel', p_label,
                             'appVersion', p_app_version, 'transferCount', v_count),
          p_client_ip);

  -- Everything the caller needs to build and sign the certificate, and nothing
  -- it does not: no key hash, no contact details, no other restaurant.
  return jsonb_build_object(
    'ok', true,
    'licenseId', v_license.license_id,
    'licenseType', v_license.license_type,
    'restaurantId', v_license.restaurant_id,
    'restaurantName', v_restaurant.name,
    'activationId', v_activation.id,
    'transferCount', v_count
  );
end;
$$;

/* -------------------------------------------------------- deactivation */

create or replace function deactivate_license(
  p_key_hash    text,
  p_fingerprint text,
  p_reason      text,
  p_client_ip   text
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
  select * into v_license from licenses where key_hash = p_key_hash;
  if not found then
    return jsonb_build_object('error', 'LICENSE_UNKNOWN_KEY', 'status', 404,
      'detail', 'no licence matches this key');
  end if;

  select * into v_live
    from activations
   where license_id = v_license.license_id and released_at is null;

  if not found then
    return jsonb_build_object('error', 'LICENSE_NOT_ACTIVE', 'status', 409,
      'detail', 'this licence has no active device binding');
  end if;

  if v_live.device_fingerprint <> p_fingerprint then
    return jsonb_build_object('error', 'LICENSE_DEVICE_MISMATCH', 'status', 403,
      'detail', 'this device does not hold the active binding for this licence');
  end if;

  update activations
     set released_at = now(),
         release_reason = coalesce(nullif(p_reason, ''), 'deactivated by the installation')
   where id = v_live.id;

  update licenses
     set status = 'DEACTIVATED', updated_at = now()
   where license_id = v_license.license_id;

  insert into audit_log (actor, action, license_id, restaurant_id, detail, client_ip)
  values ('installation', 'license.deactivated', v_license.license_id, v_license.restaurant_id,
          jsonb_build_object('deviceFingerprint', p_fingerprint, 'reason', p_reason),
          p_client_ip);

  return jsonb_build_object('ok', true, 'licenseId', v_license.license_id, 'status', 'DEACTIVATED');
end;
$$;

/* --------------------------------------------------------------- status */

create or replace function license_status(p_key_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_license    licenses%rowtype;
  v_restaurant restaurants%rowtype;
  v_live       activations%rowtype;
begin
  select * into v_license from licenses where key_hash = p_key_hash;
  if not found then
    return jsonb_build_object('error', 'LICENSE_UNKNOWN_KEY', 'status', 404,
      'detail', 'no licence matches this key');
  end if;

  select * into v_restaurant from restaurants where restaurant_id = v_license.restaurant_id;
  select * into v_live
    from activations
   where license_id = v_license.license_id and released_at is null;

  return jsonb_build_object(
    'licenseId', v_license.license_id,
    'restaurantId', v_license.restaurant_id,
    'restaurantName', coalesce(v_restaurant.name, ''),
    'status', v_license.status,
    'licenseType', v_license.license_type,
    'boundDeviceFingerprint', v_live.device_fingerprint,
    'activatedAt', v_license.activated_at,
    'transferCount', v_license.transfer_count,
    'transferCredits', v_license.transfer_credits
  );
end;
$$;

/* ------------------------------------------------------------- issuing */

-- Issuing is a vendor action, but it allocates a numbered id and must not hand
-- the same number to two licences, so it belongs in one transaction too.
create or replace function issue_license(
  p_restaurant_id   text,
  p_restaurant_name text,
  p_contact_name    text,
  p_contact_phone   text,
  p_contact_email   text,
  p_country         text,
  p_notes           text,
  p_license_type    text,
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
  v_rid        text;
  v_lid        text;
  v_n          integer;
begin
  if p_restaurant_id is not null then
    select * into v_restaurant from restaurants where restaurant_id = p_restaurant_id;
    if not found then
      return jsonb_build_object('error', 'NOT_FOUND', 'status', 404, 'detail', 'restaurant not found');
    end if;
    v_rid := v_restaurant.restaurant_id;
  else
    if coalesce(trim(p_restaurant_name), '') = '' then
      return jsonb_build_object('error', 'VALIDATION', 'status', 400,
        'detail', 'restaurantName or restaurantId is required');
    end if;
    v_n := next_counter('restaurant');
    v_rid := 'REST-' || lpad(v_n::text, 6, '0');
    insert into restaurants (restaurant_id, name, contact_name, contact_phone,
                             contact_email, country, notes)
    values (v_rid, trim(p_restaurant_name), p_contact_name, p_contact_phone,
            p_contact_email, p_country, p_notes);
  end if;

  v_n := next_counter('license');
  v_lid := 'LIC-' || to_char(now(), 'YYYY') || '-' || lpad(v_n::text, 6, '0');

  insert into licenses (license_id, restaurant_id, key_hash, key_hint, license_type, status)
  values (v_lid, v_rid, p_key_hash, p_key_hint, coalesce(p_license_type, 'PERPETUAL'), 'PENDING');

  insert into audit_log (actor, action, license_id, restaurant_id, detail)
  values (p_actor, 'license.issued', v_lid, v_rid,
          jsonb_build_object('licenseType', coalesce(p_license_type, 'PERPETUAL'),
                             'keyHint', p_key_hint));

  return jsonb_build_object('ok', true, 'licenseId', v_lid, 'restaurantId', v_rid);
end;
$$;

/* ------------------------------------------------------------- grants */

-- Only the Edge Function (service role) and a signed-in vendor may run these.
-- `anon` reaches them through the Edge Function or not at all.
revoke all on function activate_license(text, text, text, text, text, text) from public, anon;
revoke all on function deactivate_license(text, text, text, text) from public, anon;
revoke all on function license_status(text) from public, anon;
revoke all on function issue_license(text, text, text, text, text, text, text, text, text, text, text) from public, anon;
revoke all on function next_counter(text) from public, anon;

grant execute on function activate_license(text, text, text, text, text, text) to service_role;
grant execute on function deactivate_license(text, text, text, text) to service_role;
grant execute on function license_status(text) to service_role;
grant execute on function issue_license(text, text, text, text, text, text, text, text, text, text, text) to service_role, authenticated;
grant execute on function next_counter(text) to service_role;
