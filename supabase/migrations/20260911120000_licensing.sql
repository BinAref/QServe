-- QServe licensing, on Postgres.
--
-- A faithful port of the license server's SQLite schema (apps/license-server),
-- with the same column names so the vendor console can be pointed here without
-- being rewritten around a new vocabulary.
--
-- What is deliberately absent is the point of the whole design: there is no
-- menu here, no order, no product, no price, no diner. A restaurant's
-- operational data never leaves its own computer. This database knows only
-- which restaurant bought which licence and which machine is holding it.
--
-- Every table has row level security on with no policy for `anon` or
-- `authenticated`. Nothing reaches these rows except the Edge Function, which
-- uses the service role, and whatever policies the vendor console is later
-- given. A table with RLS on and no policy is closed, which is the right
-- default for a table that decides who may run a business.

/* ------------------------------------------------------------- counters */

-- REST-nnnnnn and LIC-yyyy-nnnnnn are allocated in order, and two activations
-- arriving in the same millisecond must not be handed the same number.
create table if not exists counters (
  name  text    primary key,
  value integer not null
);

insert into counters (name, value) values ('restaurant', 0), ('license', 0)
  on conflict (name) do nothing;

create or replace function next_counter(counter_name text)
returns integer
language sql
security definer
set search_path = public
as $$
  update counters
     set value = value + 1
   where name = counter_name
  returning value;
$$;

/* ---------------------------------------------------------- restaurants */

create table if not exists restaurants (
  restaurant_id text primary key,
  name          text not null,
  contact_name  text,
  contact_phone text,
  contact_email text,
  country       text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

/* ------------------------------------------------------------- licences */

create table if not exists licenses (
  license_id       text primary key,
  restaurant_id    text not null references restaurants(restaurant_id),
  -- Only the hash is stored. The plaintext key is shown to the vendor once, at
  -- issue, and is unrecoverable afterwards — including by the vendor.
  key_hash         text not null unique,
  -- The last group of the key, so a support call can identify which key a
  -- caller is holding without the key itself being kept anywhere.
  key_hint         text not null,
  license_type     text not null,
  status           text not null,
  -- Paid transfers not yet consumed. A first activation does not need one.
  transfer_credits integer not null default 0,
  transfer_count   integer not null default 0,
  activated_at     timestamptz,
  app_version      text,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_licenses_restaurant on licenses(restaurant_id);
create index if not exists idx_licenses_status on licenses(status);

/* ---------------------------------------------------------- activations */

-- One row per activation that succeeded. The current binding is the row whose
-- released_at is null; history is never deleted, because "which machine held
-- this licence in March" is a question that gets asked.
create table if not exists activations (
  id                 text primary key,
  license_id         text not null references licenses(license_id),
  device_fingerprint text not null,
  device_label       text,
  app_version        text,
  activated_at       timestamptz not null default now(),
  released_at        timestamptz,
  release_reason     text,
  client_ip          text
);

create index if not exists idx_activations_license on activations(license_id);

-- A licence may be bound to at most one live device. This is the rule the
-- whole product rests on, so it is the database that enforces it rather than
-- the code that happens to be in front of it.
create unique index if not exists idx_activations_live
  on activations(license_id) where released_at is null;

create table if not exists transfers (
  id               text primary key,
  license_id       text not null references licenses(license_id),
  from_fingerprint text,
  to_fingerprint   text,
  reason           text,
  fee_reference    text,
  performed_by     text not null,
  created_at       timestamptz not null default now()
);

create index if not exists idx_transfers_license on transfers(license_id);

/* -------------------------------------------------------- signing keys */

-- Public halves only. The private key lives in the Edge Function's secrets and
-- is readable by nothing else — not this table, not the vendor console, not a
-- database backup.
create table if not exists signing_keys (
  key_id     text primary key,
  public_key text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

/* ------------------------------------------------------ vendor settings */

-- How restaurants reach the vendor, and what a licence costs. Free text the
-- vendor writes: the application takes no payment and knows nothing about
-- money beyond what is typed here.
create table if not exists vendor_settings (
  key        text primary key,
  value_json jsonb not null,
  updated_at timestamptz not null default now()
);

/* ------------------------------------------------------------ audit log */

create table if not exists audit_log (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  actor         text not null,
  action        text not null,
  license_id    text,
  restaurant_id text,
  detail        jsonb not null default '{}'::jsonb,
  client_ip     text
);

create index if not exists idx_audit_at on audit_log(at desc);
create index if not exists idx_audit_license on audit_log(license_id);

/* ------------------------------------------------------------------ RLS */

alter table counters        enable row level security;
alter table restaurants     enable row level security;
alter table licenses        enable row level security;
alter table activations     enable row level security;
alter table transfers       enable row level security;
alter table signing_keys    enable row level security;
alter table vendor_settings enable row level security;
alter table audit_log       enable row level security;

-- The one exception: a public key is public by definition, and an installer
-- pinning it out of band is a supported thing to do.
drop policy if exists "public keys are public" on signing_keys;
create policy "public keys are public"
  on signing_keys for select
  to anon, authenticated
  using (active);
