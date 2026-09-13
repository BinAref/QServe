-- The log records who called, never who they said they were.
--
-- The previous version took the caller's word when there was no token, on the
-- reasoning that only the Edge Function holds the service key and it can be
-- trusted. True today, and the wrong shape: it leaves a parameter that decides
-- what the audit trail says, so the trail is only as good as the promise that
-- nothing else ever gets that key. An audit line that can be dictated is not
-- evidence.
--
-- A caller with a token is named by the token. A caller without one is the
-- service, and is called that. The parameter stays in the signature because
-- callers pass it, and is now ignored.

create or replace function acting_as(p_claimed text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.uid() is null then 'service'
    else coalesce(auth.jwt() ->> 'email', auth.uid()::text)
  end;
$$;
