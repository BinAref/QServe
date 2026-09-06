/**
 * License server schema (spec §26, §27).
 *
 * This database holds the minimum needed to sell and control licences. It has
 * no menu, no order, no product, no price and no customer. That separation is a
 * design requirement, not an accident: a restaurant's operational data never
 * leaves its own PC.
 */

import type { Migration } from '@qserve/db';

export const LICENSE_SERVER_SCHEMA_VERSION = 2;

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: (db) => {
      db.exec(`
        -- Vendor-side counters for REST-nnnnnn and LIC-yyyy-nnnnnn allocation.
        CREATE TABLE counters (
          name  TEXT    PRIMARY KEY,
          value INTEGER NOT NULL
        );

        CREATE TABLE restaurants (
          restaurant_id TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          contact_name  TEXT,
          contact_phone TEXT,
          contact_email TEXT,
          country       TEXT,
          notes         TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );

        CREATE TABLE licenses (
          license_id     TEXT PRIMARY KEY,
          restaurant_id  TEXT NOT NULL REFERENCES restaurants(restaurant_id),
          -- Only the hash is stored: the plaintext key is shown to the vendor
          -- once, at issue, and is unrecoverable afterwards.
          key_hash       TEXT NOT NULL UNIQUE,
          -- Last group of the key, so a support agent can identify which key a
          -- caller is holding without the key being stored.
          key_hint       TEXT NOT NULL,
          license_type   TEXT NOT NULL,
          status         TEXT NOT NULL,
          -- Paid transfers not yet consumed. First activation does not need one.
          transfer_credits INTEGER NOT NULL DEFAULT 0,
          transfer_count   INTEGER NOT NULL DEFAULT 0,
          activated_at   TEXT,
          app_version    TEXT,
          notes          TEXT,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL
        );
        CREATE INDEX idx_licenses_restaurant ON licenses(restaurant_id);
        CREATE INDEX idx_licenses_status ON licenses(status);

        -- One row per activation attempt that succeeded. The current binding is
        -- the row with released_at IS NULL; history is never deleted.
        CREATE TABLE activations (
          id                 TEXT PRIMARY KEY,
          license_id         TEXT NOT NULL REFERENCES licenses(license_id),
          device_fingerprint TEXT NOT NULL,
          device_label       TEXT,
          app_version        TEXT,
          activated_at       TEXT NOT NULL,
          released_at        TEXT,
          release_reason     TEXT,
          client_ip          TEXT
        );
        CREATE INDEX idx_activations_license ON activations(license_id);
        -- A licence may be bound to at most one live device (spec §5).
        CREATE UNIQUE INDEX idx_activations_live
          ON activations(license_id) WHERE released_at IS NULL;

        CREATE TABLE transfers (
          id               TEXT PRIMARY KEY,
          license_id       TEXT NOT NULL REFERENCES licenses(license_id),
          from_fingerprint TEXT,
          to_fingerprint   TEXT,
          reason           TEXT,
          fee_reference    TEXT,
          performed_by     TEXT NOT NULL,
          created_at       TEXT NOT NULL
        );
        CREATE INDEX idx_transfers_license ON transfers(license_id);

        -- Public halves only. The private key lives in the process environment.
        CREATE TABLE signing_keys (
          key_id     TEXT PRIMARY KEY,
          public_key TEXT NOT NULL,
          active     INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );

        CREATE TABLE admin_users (
          id            TEXT PRIMARY KEY,
          username      TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          display_name  TEXT NOT NULL,
          active        INTEGER NOT NULL DEFAULT 1,
          created_at    TEXT NOT NULL,
          last_login_at TEXT
        );

        CREATE TABLE admin_sessions (
          token_hash TEXT PRIMARY KEY,
          admin_id   TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          client_ip  TEXT
        );
        CREATE INDEX idx_admin_sessions_admin ON admin_sessions(admin_id);

        CREATE TABLE audit_log (
          id            TEXT PRIMARY KEY,
          at            TEXT NOT NULL,
          actor         TEXT NOT NULL,
          action        TEXT NOT NULL,
          license_id    TEXT,
          restaurant_id TEXT,
          detail        TEXT NOT NULL,
          client_ip     TEXT
        );
        CREATE INDEX idx_audit_at ON audit_log(at DESC);
        CREATE INDEX idx_audit_license ON audit_log(license_id);
      `);

      db.prepare('INSERT INTO counters (name, value) VALUES (?, ?)').run('restaurant', 0);
      db.prepare('INSERT INTO counters (name, value) VALUES (?, ?)').run('license', 0);
    },
  },
  {
    version: 2,
    name: 'vendor_settings',
    up: (db) => {
      db.exec(`
        -- How restaurants reach the vendor, and what a licence costs. Free text
        -- written by the vendor: the application takes no payment and knows
        -- nothing about money beyond what is typed here.
        CREATE TABLE vendor_settings (
          key        TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
];
