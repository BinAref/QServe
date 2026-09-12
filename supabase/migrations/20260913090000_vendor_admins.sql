-- Who counts as the vendor, and who may write history.
--
-- The previous migration granted every table to `authenticated` with
-- `using (true)`, on the reasoning that this project holds one vendor's
-- licences and therefore anybody signed in to it is that vendor. That
-- reasoning is wrong in a way that matters: Supabase projects accept public
-- sign-ups by default, so "authenticated" is not the vendor — it is anybody at
-- all who has an email address. The first stranger to sign up would have been
-- able to read every customer's contact details, revoke licences, grant
-- themselves transfer credits and mint new ones.
--
-- Nobody had, because the project has no users yet. This closes it before
-- anybody does.
--
-- The gate is an explicit list, empty at the start. Being signed in grants
-- nothing; being named in `vendor_admins` grants everything. Fail closed, and
-- the vendor adds themselves once, deliberately, from the SQL editor.

create table if not exists vendor_admins (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  note     text,
  added_at timestamptz not null default now()
);

alter table vendor_admins enable row level security;

-- Deliberately readable by the people on it and by nobody else, so the vendor
-- console can tell whether the person signed in is allowed to be there.
drop policy if exists "an admin sees the list" on vendor_admins;
create policy "an admin sees the list" on vendor_admins
  for select to authenticated using (user_id = (select auth.uid()));

grant select on vendor_admins to authenticated;
grant all privileges on vendor_admins to service_role;

/*
 * `stable`, not `volatile`: Postgres then evaluates it once per statement
 * rather than once per row, which is the difference between a policy that
 * costs nothing and one that costs a subquery for every licence in the table.
 */
create or replace function is_vendor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from vendor_admins where user_id = auth.uid());
$$;

revoke all on function is_vendor() from public, anon;
grant execute on function is_vendor() to authenticated, service_role;

/* ------------------------------------------------- the tables, re-gated */

drop policy if exists "the vendor reads restaurants" on restaurants;
create policy "the vendor reads restaurants" on restaurants
  for all to authenticated using (is_vendor()) with check (is_vendor());

drop policy if exists "the vendor reads licences" on licenses;
create policy "the vendor reads licences" on licenses
  for all to authenticated using (is_vendor()) with check (is_vendor());

drop policy if exists "the vendor reads activations" on activations;
create policy "the vendor reads activations" on activations
  for select to authenticated using (is_vendor());

drop policy if exists "the vendor reads transfers" on transfers;
create policy "the vendor reads transfers" on transfers
  for all to authenticated using (is_vendor()) with check (is_vendor());

drop policy if exists "the vendor reads its settings" on vendor_settings;
create policy "the vendor reads its settings" on vendor_settings
  for all to authenticated using (is_vendor()) with check (is_vendor());

drop policy if exists "the vendor reads the log" on audit_log;
create policy "the vendor reads the log" on audit_log
  for select to authenticated using (is_vendor());

/* ---------------------------------------------- history is not writable */

/*
 * The previous migration said "writing history is the database's job, not a
 * client's" and then granted clients the right to write it, which is the sort
 * of contradiction that survives review because the comment sounds correct.
 *
 * An audit log a client can append to is not evidence. Anyone signed in could
 * have written "license.activated by installation" for a licence they had
 * never touched, and the row would be indistinguishable from a real one. The
 * functions that record real history are `security definer` and write as their
 * owner, so they never needed this grant either.
 */
drop policy if exists "the vendor writes the log" on audit_log;
revoke insert, update, delete on audit_log from authenticated;

-- Same reasoning one level down: an activation row is written by
-- `activate_license`, never by a client.
revoke insert, update, delete on activations from authenticated;

/* --------------------------------------------------- issuing a licence */

-- `issue_license` is `security definer`, so it bypasses the policies above and
-- has to check for itself who is asking. Without this, the execute grant to
-- `authenticated` was a way for anybody with an account to mint licences.
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
  -- The Edge Function calls this as the service role, which has no `auth.uid()`
  -- and is trusted by definition; a person calling it must be on the list.
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

revoke all on function issue_license(text, text, text, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function issue_license(text, text, text, text, text, text, text, text, text, text, text) to service_role, authenticated;
