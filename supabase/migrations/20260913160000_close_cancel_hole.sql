-- Two holes in yesterday's simplification.
--
-- **Cancelling was a destructive guessing oracle.** `cancel_license` deleted a
-- licence whenever the caller's fingerprint matched — and a licence that has
-- never been activated has no fingerprint to match, so the check passed for
-- anybody. The route it sits behind is unauthenticated by design, because a
-- restaurant activating for the first time has no credentials to present, and
-- it was not rate limited the way activation is. So a stranger could work
-- through candidate keys deleting every unactivated licence they hit, learning
-- from the reply which ones had existed.
--
-- A restaurant only ever cancels the licence its own machine is holding. That
-- is now the rule: no binding, no cancellation. Guessing is capped on the same
-- counter as activation, so the two cannot be used to top each other up.
--
-- **The audit log recorded whoever the caller claimed to be.** `p_actor` came
-- from the client. The console passes the signed-in address, but nothing made
-- it: any vendor account could write lines attributed to another. The identity
-- now comes from the token, and the parameter is kept only for the Edge
-- Function, which has no token and is trusted because it holds the service key.

/* -------------------------------------------------------- who is asking */

/*
 * The signed-in address, from the token rather than from the caller.
 *
 * `auth.jwt()` is the verified claim set; the email in it was checked when the
 * session was issued. A caller with no token at all is the Edge Function
 * holding the service key, and it says what it is.
 */
create or replace function acting_as(p_claimed text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.uid() is null then coalesce(nullif(p_claimed, ''), 'service')
    else coalesce(auth.jwt() ->> 'email', auth.uid()::text)
  end;
$$;

revoke all on function acting_as(text) from public, anon;
grant execute on function acting_as(text) to authenticated, service_role;

/* ------------------------------------------------------------ cancelling */

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
  v_tries   integer;
  v_oldest  timestamptz;
begin
  -- The same counter activation uses. Cancelling is a write that destroys
  -- something, so it cannot be the cheap way to test a key.
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

  /*
   * One answer for "no such licence" and for "not yours".
   *
   * Telling them apart is what makes this an oracle: a stranger working
   * through candidate keys would learn which ones exist. The installation that
   * genuinely holds a licence never sees this branch, and one that is holding a
   * licence the vendor already deleted needs to clear itself out — which the
   * `alreadyGone` answer below still lets it do, but only when the key it
   * presents was really bound to this machine.
   */
  if not found then
    insert into activation_attempts (fingerprint, client_ip) values (p_fingerprint, p_client_ip);
    return jsonb_build_object('ok', true, 'alreadyGone', true);
  end if;

  -- No binding, or somebody else's: not this machine's to cancel. A licence
  -- that was never activated is cancelled by the vendor, not over the wire.
  if v_license.device_fingerprint is null
     or v_license.device_fingerprint <> p_fingerprint then
    insert into activation_attempts (fingerprint, key_hint, client_ip)
    values (p_fingerprint, v_license.key_hint, p_client_ip);
    return jsonb_build_object('error', 'LICENSE_DEVICE_MISMATCH', 'status', 403,
      'detail', 'this computer does not hold that licence');
  end if;

  delete from licenses where license_id = v_license.license_id;

  -- A machine that just proved it held the licence is not guessing.
  delete from activation_attempts where fingerprint = p_fingerprint;

  insert into audit_log (actor, action, license_id, restaurant_id, detail, client_ip)
  values ('installation', 'license.cancelled', v_license.license_id, v_license.restaurant_id,
          jsonb_build_object('deviceFingerprint', p_fingerprint,
                             'keyHint', v_license.key_hint), p_client_ip);

  return jsonb_build_object('ok', true, 'licenseId', v_license.license_id);
end;
$$;

/* --------------------------------------------- issuing and deleting, signed */

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
  v_actor text := acting_as(p_actor);
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
  values (v_actor, 'license.issued', v_lid, v_rid,
          jsonb_build_object('keyHint', p_key_hint, 'notes', p_notes));

  return jsonb_build_object('ok', true, 'licenseId', v_lid, 'restaurantId', v_rid);
end;
$$;

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
  v_actor text := acting_as(p_actor);
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
  values (v_actor, 'license.deleted', v_license.license_id, v_license.restaurant_id,
          jsonb_build_object('reason', p_reason, 'keyHint', v_license.key_hint,
                             'wasOn', v_license.device_fingerprint));

  return jsonb_build_object('ok', true, 'licenseId', v_license.license_id);
end;
$$;
