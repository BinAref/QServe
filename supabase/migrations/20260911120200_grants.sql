-- Who may reach these tables through the API at all.
--
-- Row level security decides which *rows* a role may see. It says nothing
-- about whether the role may touch the table in the first place, and a table
-- created by a migration carries no privileges for the roles PostgREST speaks
-- as. The result is a 403 that looks exactly like a policy problem and is not
-- one: "permission denied for table signing_keys", from a role that would have
-- been allowed every row in it.
--
-- So the grants are written out here, explicitly, next to the policies they are
-- forever going to be confused with.

grant usage on schema public to anon, authenticated, service_role;

-- The service role is what the Edge Function presents. It bypasses RLS by
-- design; this is what lets it through the door to do so.
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- A public key is public by definition, and the RLS policy above it already
-- narrows this to the keys that are still active.
grant select on signing_keys to anon, authenticated;

/*
 * The vendor's console signs in as a real Supabase user and reads these rows
 * directly — that is the whole point of moving here, and it is why the console
 * needs no server of its own. Every table is still behind RLS; these grants
 * only make the tables reachable for a signed-in vendor, and the policies
 * below decide what they may actually do.
 */
grant select, insert, update on restaurants     to authenticated;
grant select, insert, update on licenses        to authenticated;
grant select                  on activations    to authenticated;
grant select, insert          on transfers      to authenticated;
grant select, insert, update  on vendor_settings to authenticated;
grant select, insert          on audit_log      to authenticated;

-- Anyone who has signed in to this project is the vendor. There is exactly one
-- organisation here and no notion of a customer account, so "authenticated"
-- and "the vendor" are the same set of people — a distinction to revisit only
-- if this project ever hosts somebody else's licences.
drop policy if exists "the vendor reads restaurants" on restaurants;
create policy "the vendor reads restaurants" on restaurants
  for all to authenticated using (true) with check (true);

drop policy if exists "the vendor reads licences" on licenses;
create policy "the vendor reads licences" on licenses
  for all to authenticated using (true) with check (true);

drop policy if exists "the vendor reads activations" on activations;
create policy "the vendor reads activations" on activations
  for select to authenticated using (true);

drop policy if exists "the vendor reads transfers" on transfers;
create policy "the vendor reads transfers" on transfers
  for all to authenticated using (true) with check (true);

drop policy if exists "the vendor reads its settings" on vendor_settings;
create policy "the vendor reads its settings" on vendor_settings
  for all to authenticated using (true) with check (true);

drop policy if exists "the vendor reads the log" on audit_log;
create policy "the vendor reads the log" on audit_log
  for select to authenticated using (true);

-- Writing history is the database's job, not a client's: audit lines are
-- inserted by the functions above, which run as their definer.
drop policy if exists "the vendor writes the log" on audit_log;
create policy "the vendor writes the log" on audit_log
  for insert to authenticated with check (true);
