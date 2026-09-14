# The licence server, in Supabase

The vendor does not keep a computer switched on. A restaurant that wants to
activate talks to a Supabase project, and that project is this directory.

    project   QServer — zhycxmaqtazjumhzfxeq (ap-south-1)
    address   https://zhycxmaqtazjumhzfxeq.supabase.co/functions/v1

Restaurants never see that URL. It is written into every packaged build from
the `QSERVE_VENDOR_URL` repository secret, and a restaurant activates by typing
its key and nothing else.

## What is here

    migrations/   the schema: restaurants, licences, activations, transfers,
                  signing keys, vendor settings and an audit log
    functions/api the four routes a restaurant calls

`apps/license-server` — the Node server this replaces — is still in the
repository and still works. It is what the vendor desktop application runs, and
it is useful for testing offline. Nothing in `apps/server` knows which of the
two it is talking to.

## Who does what

**Postgres decides.** Whether a licence may bind to a machine, whether a
transfer is owed, what the audit line says: all of it is in `activate_license`,
in one transaction, beside the partial unique index that makes "one live
device" true rather than merely intended.

**The Edge Function signs.** It holds the Ed25519 private key. The database has
never seen it, so a database backup cannot leak it, and nothing else in the
system can mint a certificate.

**The application verifies offline.** A restaurant checks its certificate
against public keys shipped inside the build. That is why a restaurant keeps
trading when this project, or its own internet connection, is unavailable.

## Deploying a change

    supabase login --token <a personal access token>
    supabase link --project-ref zhycxmaqtazjumhzfxeq
    supabase db push
    supabase functions deploy api --no-verify-jwt

`--no-verify-jwt` is not an oversight. A restaurant activating for the first
time has no credentials to present — that is what activation is for — so these
routes are open, and the licence key's own checksum plus a per-address rate
limit are what stand in the way of a stranger.

## The signing key

Generated with the repository's own tool, so the vendor desktop application and
this project produce identical certificates:

    node apps/license-server/dist/tools/keygen.js --out key.json --trust trust.json

The private half goes to Supabase and nowhere else:

    supabase secrets set --env-file secrets.env   # QSERVE_SIGNING_PRIVATE_KEY, QSERVE_SIGNING_PUBLIC_KEY

The public half goes two places: the `signing_keys` table, so
`/v1/public-keys` can publish it, and the `QSERVE_TRUSTED_KEYS` repository
secret, so builds trust it.

**Rotating** means adding, not replacing. A trust store holds several keys on
purpose: certificates already in the field keep verifying against the key that
signed them while new ones are signed by the new key. Removing a key from the
trust store retires every certificate it ever signed.

## Becoming the vendor

Signing in to the project grants nothing. Access is an explicit list, empty
until somebody is put on it, because a Supabase project accepts public
sign-ups by default and "anybody with an email address" is not the vendor.

The account for this project exists: **a.binaref@gmail.com**, created in
Authentication → Users and named in `vendor_admins`. For a second one, or for
a fresh project, it is two steps:

    insert into vendor_admins (user_id, note)
    select id, 'the vendor' from auth.users where email = 'you@example.com';

From then on that account reads and writes every licence through PostgREST
directly, with no server in between — which is the whole reason the licence
server moved here. Everyone else who signs in sees an empty database: not an
error, just no rows, which is what row level security looks like from outside.

The password is changed in the console itself, under **Account**. It asks for
the current one first and uses the token that proves it, so somebody who walks
up to an unlocked console cannot change it without knowing the old one.

## Windows Hello, and why the console is served rather than opened

The vendor application used to write `console.html` to disk and hand the file
to a browser. It now serves that same page on `http://localhost:8787` and
closes itself a minute after the page stops answering.

The reason is WebAuthn. A `file://` page has no domain, and a passkey belongs
to a domain, so Windows Hello could never have worked from a file. The port is
remembered in `port.txt` and reused, because the saved sign-in, the archive of
deleted licences and the Hello enrolment all live in `localStorage`, which is
per origin — and an origin includes the port. A second copy of the application
notices the first and just opens a browser at it.

What Hello actually protects is the refresh token. Holding that token *is*
being the vendor, and it used to sit in `localStorage` in the clear, restored
on load without asking anybody anything. A passkey alone would not fix that —
an assertion is a yes or a no, and a page can be told to skip the question. The
`prf` extension is what fixes it: the authenticator returns 32 bytes that exist
only after a real face, fingerprint or PIN, and the refresh token is encrypted
with them. Where a computer's Hello cannot do `prf`, the passkey is still
required before the saved token is used — a lock on the screen rather than on
the file — and the Account panel says which of the two that computer is doing.

The password is always underneath. A fingerprint reader that has stopped
working is a bad day, not a lockout.

The Edge Function is unaffected either way. It uses the service role, is what
restaurants talk to, and never asks who anybody is.

## Checking the two implementations still agree

    npm run validate:supabase

Signing and verifying are now two implementations in two runtimes that will be
edited on different days. This imports the actual Edge Function source, signs
with it, and hands the result to the application's real verifier. A
disagreement would otherwise surface as a restaurant that has paid, activating
successfully, holding a certificate its own computer refuses — with nothing in
either log saying why.

## What this project must never learn

There is no menu here, no order, no product, no price, no diner. A restaurant's
operational data never leaves its own computer. This database knows only which
restaurant bought which licence and which machine is holding it, and every
table is behind row level security with no policy for `anon`.
