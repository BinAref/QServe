/**
 * Operational database schema (spec §25).
 *
 * Two rules shape every table here:
 *
 *  1. **Restaurant ID owns the data, never the device** (spec §4, §50). No
 *     table stores a device fingerprint as an ownership key. Replacing the PC
 *     means restoring a backup, not rebuilding a menu.
 *
 *  2. **Orders are history, not views of the menu.** An order item copies the
 *     product's name and price at the moment it was ordered. Re-pricing the
 *     menu tomorrow must not silently rewrite yesterday's receipts.
 *
 * Localised text (`*_json` columns holding `{"en": "...", "ar": "..."}`) is
 * stored as JSON rather than as a translations table: it is always read whole,
 * always written whole, and never queried by language.
 */

import type { Migration } from '@qserve/db';
import { DEFAULT_ROLE_PERMISSIONS, SystemRole } from '@qserve/shared';

export const RESTAURANT_SCHEMA_VERSION = 4;

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: (db) => {
      db.exec(`
        /* ------------------------------------------------------ identity */

        -- Exactly one row. The restaurant this installation serves.
        CREATE TABLE restaurant (
          singleton            INTEGER PRIMARY KEY CHECK (singleton = 1),
          restaurant_id        TEXT    NOT NULL,
          name_json            TEXT    NOT NULL,
          legal_name           TEXT,
          logo_asset_id        TEXT,
          address              TEXT,
          phone                TEXT,
          email                TEXT,
          tax_number           TEXT,
          currency_json        TEXT    NOT NULL,
          tax_rate_percent     REAL    NOT NULL DEFAULT 0,
          tax_inclusive        INTEGER NOT NULL DEFAULT 0,
          service_rate_percent REAL    NOT NULL DEFAULT 0,
          default_locale       TEXT    NOT NULL DEFAULT 'en',
          enabled_locales_json TEXT    NOT NULL DEFAULT '["en"]',
          theme_id             TEXT    NOT NULL DEFAULT 'light',
          created_at           TEXT    NOT NULL,
          updated_at           TEXT    NOT NULL
        );

        -- Licence state as this installation understands it. The signed
        -- certificate is the authority; these columns are a readable cache.
        CREATE TABLE license_state (
          singleton         INTEGER PRIMARY KEY CHECK (singleton = 1),
          license_id        TEXT,
          license_type      TEXT,
          status            TEXT    NOT NULL DEFAULT 'NONE',
          certificate_json  TEXT,
          activated_at      TEXT,
          transfer_count    INTEGER NOT NULL DEFAULT 0,
          last_verdict      TEXT    NOT NULL DEFAULT 'MISSING',
          last_checked_at   TEXT,
          key_hint          TEXT,
          updated_at        TEXT    NOT NULL
        );

        CREATE TABLE settings (
          key        TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE counters (
          name  TEXT    PRIMARY KEY,
          value INTEGER NOT NULL
        );

        /* -------------------------------------------------------- people */

        CREATE TABLE roles (
          id          TEXT PRIMARY KEY,
          key         TEXT NOT NULL UNIQUE,
          name_json   TEXT NOT NULL,
          -- System roles cannot be deleted, but their permissions are editable.
          is_system   INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL
        );

        CREATE TABLE role_permissions (
          role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
          permission TEXT NOT NULL,
          PRIMARY KEY (role_id, permission)
        );

        CREATE TABLE users (
          id            TEXT PRIMARY KEY,
          username      TEXT NOT NULL UNIQUE,
          display_name  TEXT NOT NULL,
          -- scrypt hash of the staff PIN or password.
          secret_hash   TEXT NOT NULL,
          active        INTEGER NOT NULL DEFAULT 1,
          created_at    TEXT NOT NULL,
          last_login_at TEXT
        );

        CREATE TABLE user_roles (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
          PRIMARY KEY (user_id, role_id)
        );

        CREATE TABLE user_sessions (
          token_hash TEXT PRIMARY KEY,
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          -- Terminal the person signed in on, so every action carries both the
          -- human and the station (spec §15).
          terminal_id TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          client_ip  TEXT
        );
        CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);

        /* ----------------------------------------------------- terminals */

        CREATE TABLE terminals (
          id                 TEXT PRIMARY KEY,
          terminal_type      TEXT NOT NULL,
          name_json          TEXT NOT NULL,
          status             TEXT NOT NULL DEFAULT 'ACTIVE',
          -- Extra grants beyond the type ceiling, as a JSON array.
          permissions_json   TEXT NOT NULL DEFAULT '[]',
          config_json        TEXT NOT NULL DEFAULT '{}',
          sound_profile_json TEXT NOT NULL DEFAULT '{}',
          -- Secret embedded in the printed QR. Stored recoverable, not hashed,
          -- and deliberately so: a restored backup must keep every already
          -- printed table card working, which is the whole point of spec §8.
          -- The trade-off is written up in docs/SECURITY.md.
          enrol_token        TEXT NOT NULL,
          -- Short public code that appears in the QR URL, so support can read
          -- a code off a printed card without exposing the secret.
          public_code        TEXT NOT NULL UNIQUE,
          last_seen_at       TEXT,
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL
        );
        CREATE INDEX idx_terminals_type ON terminals(terminal_type);

        CREATE TABLE terminal_sessions (
          token_hash  TEXT PRIMARY KEY,
          terminal_id TEXT NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
          created_at  TEXT NOT NULL,
          expires_at  TEXT NOT NULL,
          client_ip   TEXT,
          user_agent  TEXT
        );
        CREATE INDEX idx_terminal_sessions_terminal ON terminal_sessions(terminal_id);

        /* -------------------------------------------------------- tables */

        CREATE TABLE dining_tables (
          id          TEXT PRIMARY KEY,
          label       TEXT NOT NULL,
          seats       INTEGER NOT NULL DEFAULT 4,
          zone        TEXT,
          status      TEXT NOT NULL DEFAULT 'AVAILABLE',
          -- Every table is backed by a TABLE terminal, so tables and stations
          -- share one QR, session and permission pipeline (spec §24).
          terminal_id TEXT NOT NULL UNIQUE REFERENCES terminals(id) ON DELETE CASCADE,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );

        /* ---------------------------------------------------------- menu */

        CREATE TABLE categories (
          id               TEXT PRIMARY KEY,
          name_json        TEXT NOT NULL,
          description_json TEXT NOT NULL DEFAULT '{}',
          image_asset_id   TEXT,
          sort_order       INTEGER NOT NULL DEFAULT 0,
          visible          INTEGER NOT NULL DEFAULT 1,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        );

        CREATE TABLE products (
          id                  TEXT PRIMARY KEY,
          category_id         TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
          name_json           TEXT NOT NULL,
          description_json    TEXT NOT NULL DEFAULT '{}',
          image_asset_id      TEXT,
          price_minor         INTEGER NOT NULL DEFAULT 0,
          sort_order          INTEGER NOT NULL DEFAULT 0,
          visible             INTEGER NOT NULL DEFAULT 1,
          -- "visible" is the menu design switch; "available" is today's 86 list.
          available           INTEGER NOT NULL DEFAULT 1,
          station             TEXT,
          preparation_minutes INTEGER,
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL
        );
        CREATE INDEX idx_products_category ON products(category_id, sort_order);
        CREATE INDEX idx_products_station ON products(station);

        CREATE TABLE product_options (
          id          TEXT PRIMARY KEY,
          product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          name_json   TEXT NOT NULL,
          required    INTEGER NOT NULL DEFAULT 0,
          min_select  INTEGER NOT NULL DEFAULT 0,
          max_select  INTEGER NOT NULL DEFAULT 1,
          sort_order  INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_product_options_product ON product_options(product_id, sort_order);

        CREATE TABLE option_choices (
          id                TEXT PRIMARY KEY,
          option_id         TEXT NOT NULL REFERENCES product_options(id) ON DELETE CASCADE,
          name_json         TEXT NOT NULL,
          price_delta_minor INTEGER NOT NULL DEFAULT 0,
          sort_order        INTEGER NOT NULL DEFAULT 0,
          available         INTEGER NOT NULL DEFAULT 1,
          is_default        INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_option_choices_option ON option_choices(option_id, sort_order);

        -- Add-ons are restaurant-wide and attached to products many-to-many, so
        -- "extra cheese" is priced in one place.
        CREATE TABLE addons (
          id          TEXT PRIMARY KEY,
          name_json   TEXT NOT NULL,
          price_minor INTEGER NOT NULL DEFAULT 0,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          available   INTEGER NOT NULL DEFAULT 1,
          created_at  TEXT NOT NULL
        );

        CREATE TABLE product_addons (
          product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          addon_id   TEXT NOT NULL REFERENCES addons(id) ON DELETE CASCADE,
          PRIMARY KEY (product_id, addon_id)
        );

        CREATE TABLE assets (
          id           TEXT PRIMARY KEY,
          kind         TEXT NOT NULL,
          content_type TEXT NOT NULL,
          byte_size    INTEGER NOT NULL,
          sha256       TEXT NOT NULL,
          file_name    TEXT NOT NULL,
          created_at   TEXT NOT NULL
        );

        /* -------------------------------------------------------- orders */

        CREATE TABLE orders (
          id              TEXT PRIMARY KEY,
          order_number    INTEGER NOT NULL,
          business_day    TEXT NOT NULL,
          table_id        TEXT REFERENCES dining_tables(id),
          -- Denormalised so a closed order still prints its table after that
          -- table is renamed or removed.
          table_label     TEXT,
          status          TEXT NOT NULL,
          source          TEXT NOT NULL,
          created_by_kind TEXT NOT NULL,
          created_by_user_id     TEXT REFERENCES users(id),
          created_by_user_name   TEXT,
          created_by_terminal_id TEXT REFERENCES terminals(id),
          created_by_terminal_name TEXT,
          served_by_user_id      TEXT REFERENCES users(id),
          served_by_user_name    TEXT,
          paid_by_user_id        TEXT REFERENCES users(id),
          paid_by_user_name      TEXT,
          paid_by_terminal_id    TEXT REFERENCES terminals(id),
          paid_by_terminal_name  TEXT,
          subtotal_minor  INTEGER NOT NULL DEFAULT 0,
          discount_minor  INTEGER NOT NULL DEFAULT 0,
          tax_minor       INTEGER NOT NULL DEFAULT 0,
          service_minor   INTEGER NOT NULL DEFAULT 0,
          total_minor     INTEGER NOT NULL DEFAULT 0,
          currency_json   TEXT NOT NULL,
          notes           TEXT,
          guest_count     INTEGER,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          closed_at       TEXT
        );
        CREATE UNIQUE INDEX idx_orders_number ON orders(business_day, order_number);
        CREATE INDEX idx_orders_status ON orders(status);
        CREATE INDEX idx_orders_table ON orders(table_id, status);
        CREATE INDEX idx_orders_created ON orders(created_at DESC);
        CREATE INDEX idx_orders_day ON orders(business_day);

        CREATE TABLE order_items (
          id               TEXT PRIMARY KEY,
          order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          product_id       TEXT,
          -- Captured at order time; deliberately not a join to products.
          name_json        TEXT NOT NULL,
          unit_price_minor INTEGER NOT NULL,
          quantity         INTEGER NOT NULL,
          notes            TEXT,
          station          TEXT,
          line_total_minor INTEGER NOT NULL,
          sort_order       INTEGER NOT NULL DEFAULT 0,
          created_at       TEXT NOT NULL
        );
        CREATE INDEX idx_order_items_order ON order_items(order_id, sort_order);

        CREATE TABLE order_item_selections (
          id                TEXT PRIMARY KEY,
          order_item_id     TEXT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
          option_id         TEXT,
          choice_id         TEXT,
          name_json         TEXT NOT NULL,
          price_delta_minor INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_selections_item ON order_item_selections(order_item_id);

        CREATE TABLE order_item_addons (
          id            TEXT PRIMARY KEY,
          order_item_id TEXT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
          addon_id      TEXT,
          name_json     TEXT NOT NULL,
          price_minor   INTEGER NOT NULL DEFAULT 0,
          quantity      INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX idx_item_addons_item ON order_item_addons(order_item_id);

        CREATE TABLE payments (
          id              TEXT PRIMARY KEY,
          order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          method          TEXT NOT NULL,
          status          TEXT NOT NULL,
          amount_minor    INTEGER NOT NULL,
          tendered_minor  INTEGER,
          change_minor    INTEGER,
          reference       TEXT,
          captured_by_user_id     TEXT REFERENCES users(id),
          captured_by_user_name   TEXT,
          captured_by_terminal_id TEXT REFERENCES terminals(id),
          captured_by_terminal_name TEXT,
          captured_at     TEXT,
          created_at      TEXT NOT NULL
        );
        CREATE INDEX idx_payments_order ON payments(order_id);
        CREATE INDEX idx_payments_captured ON payments(captured_at DESC);

        /* ------------------------------------------------------ printing */

        CREATE TABLE printers (
          id                  TEXT PRIMARY KEY,
          name                TEXT NOT NULL,
          transport           TEXT NOT NULL,
          target              TEXT NOT NULL,
          document_types_json TEXT NOT NULL DEFAULT '[]',
          stations_json       TEXT NOT NULL DEFAULT '[]',
          characters_per_line INTEGER NOT NULL DEFAULT 42,
          enabled             INTEGER NOT NULL DEFAULT 1,
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL
        );

        CREATE TABLE print_jobs (
          id            TEXT PRIMARY KEY,
          printer_id    TEXT NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
          document_type TEXT NOT NULL,
          order_id      TEXT REFERENCES orders(id) ON DELETE SET NULL,
          payload       TEXT NOT NULL,
          status        TEXT NOT NULL DEFAULT 'QUEUED',
          attempts      INTEGER NOT NULL DEFAULT 0,
          last_error    TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );
        CREATE INDEX idx_print_jobs_status ON print_jobs(status, created_at);

        /* --------------------------------------------------------- audit */

        -- Append-only. Nothing in the application updates or deletes a row here.
        CREATE TABLE audit_log (
          id          TEXT PRIMARY KEY,
          at          TEXT NOT NULL,
          action      TEXT NOT NULL,
          actor_kind  TEXT NOT NULL,
          actor_user_id       TEXT,
          actor_user_name     TEXT,
          actor_terminal_id   TEXT,
          actor_terminal_name TEXT,
          entity_type TEXT NOT NULL,
          entity_id   TEXT,
          order_id    TEXT,
          table_id    TEXT,
          before_json TEXT,
          after_json  TEXT,
          detail_json TEXT NOT NULL DEFAULT '{}',
          client_ip   TEXT
        );
        CREATE INDEX idx_audit_at ON audit_log(at DESC);
        CREATE INDEX idx_audit_order ON audit_log(order_id, at);
        CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);

        CREATE TABLE backups (
          id           TEXT PRIMARY KEY,
          file_name    TEXT NOT NULL,
          byte_size    INTEGER NOT NULL,
          checksum     TEXT NOT NULL,
          app_version  TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          note         TEXT,
          created_at   TEXT NOT NULL
        );
      `);

      db.prepare('INSERT INTO counters (name, value) VALUES (?, ?)').run('order_number', 1000);
      db.prepare('INSERT INTO counters (name, value) VALUES (?, ?)').run('table_sequence', 0);

      db.prepare(`
        INSERT INTO license_state (singleton, status, last_verdict, transfer_count, updated_at)
        VALUES (1, 'NONE', 'MISSING', 0, ?)
      `).run(new Date().toISOString());

      // Seed the built-in roles with their default grants. These are ordinary
      // rows: a restaurant can re-scope any of them without a code change.
      const insertRole = db.prepare(`
        INSERT INTO roles (id, key, name_json, is_system, created_at) VALUES (?, ?, ?, 1, ?)
      `);
      const insertGrant = db.prepare(
        'INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)',
      );
      const at = new Date().toISOString();

      for (const key of Object.values(SystemRole)) {
        const roleId = `ROLE-${key}`;
        insertRole.run(roleId, key, JSON.stringify({ en: key, ar: key }), at);
        for (const permission of DEFAULT_ROLE_PERMISSIONS[key]) {
          insertGrant.run(roleId, permission);
        }
      }
    },
  },

  {
    version: 2,
    name: 'restaurant_authored_packs',
    up: (db) => {
      db.exec(`
        /*
         * Languages and themes a restaurant authors for itself.
         *
         * The packs shipped by the vendor live in files under locales/ and
         * themes/. These are the restaurant's own, so they belong in the
         * restaurant's database and travel in its backups — a restaurant that
         * translated its whole menu into French must not lose that work when
         * the computer is replaced.
         *
         * At read time a restaurant pack is merged over the file-based one of
         * the same code, so a restaurant may also correct a shipped wording
         * without waiting for a release.
         */
        CREATE TABLE custom_locales (
          locale        TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          english_name  TEXT NOT NULL,
          direction     TEXT NOT NULL,
          fallback      TEXT,
          -- Interface strings: the same dotted keys the shipped packs use.
          strings_json  TEXT NOT NULL DEFAULT '{}',
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );

        CREATE TABLE custom_themes (
          id           TEXT PRIMARY KEY,
          name         TEXT NOT NULL,
          color_scheme TEXT NOT NULL,
          tokens_json  TEXT NOT NULL,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    name: 'currencies',
    up: (db) => {
      db.exec(`
        -- Currencies the restaurant accepts, as the owner defines them.
        -- Exactly one is the base: what the till counts and the reports add up.
        CREATE TABLE currencies (
          code            TEXT PRIMARY KEY,
          symbol          TEXT NOT NULL,
          name_json       TEXT NOT NULL DEFAULT '{}',
          decimals        INTEGER NOT NULL DEFAULT 2,
          symbol_position TEXT NOT NULL DEFAULT 'after',
          -- Base minor units per one minor unit of this currency; the base is 1.
          rate_to_base    REAL NOT NULL DEFAULT 1,
          is_base         INTEGER NOT NULL DEFAULT 0,
          enabled         INTEGER NOT NULL DEFAULT 1,
          sort_order      INTEGER NOT NULL DEFAULT 0,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        );
        -- Exactly one base currency, enforced by the storage engine rather than
        -- by an "if" somebody can forget: two bases would make every total
        -- ambiguous.
        CREATE UNIQUE INDEX idx_currencies_base ON currencies(is_base) WHERE is_base = 1;

        -- NULL means the base currency, so every existing product keeps its
        -- price and its meaning without a data migration.
        ALTER TABLE products ADD COLUMN currency_code TEXT REFERENCES currencies(code);
        ALTER TABLE addons   ADD COLUMN currency_code TEXT REFERENCES currencies(code);

        -- What an order line was priced in, and the rate that applied when it
        -- was taken. Stored, not looked up: a bill printed last month must not
        -- change because the rate moved this morning.
        ALTER TABLE order_items ADD COLUMN currency_code TEXT;
        ALTER TABLE order_items ADD COLUMN rate_to_base REAL NOT NULL DEFAULT 1;
        -- The line in the currency the till settles in.
        ALTER TABLE order_items ADD COLUMN base_total_minor INTEGER;
      `);

      // Seed the base currency from what the restaurant already uses, so an
      // upgraded installation is in exactly the state a new one would be.
      const row = db
        .prepare('SELECT currency_json FROM restaurant WHERE singleton = 1')
        .get() as { currency_json: string } | undefined;

      if (row) {
        const currency = JSON.parse(row.currency_json) as {
          code: string; symbol: string; decimals: number; symbolPosition: string;
        };
        const at = new Date().toISOString();
        db.prepare(`
          INSERT INTO currencies
            (code, symbol, name_json, decimals, symbol_position,
             rate_to_base, is_base, enabled, sort_order, created_at, updated_at)
          VALUES (?, ?, '{}', ?, ?, 1, 1, 1, 0, ?, ?)
        `).run(
          currency.code, currency.symbol, currency.decimals,
          currency.symbolPosition, at, at,
        );
      }
    },
  },
  {
    version: 4,
    name: 'notifications',
    up: (db) => {
      db.exec(`
        -- What one station tells another. A restaurant runs on shouted
        -- sentences; these are the same sentences, routed to whoever needs to
        -- hear them and kept until somebody says they heard.
        CREATE TABLE notifications (
          id             TEXT PRIMARY KEY,
          kind           TEXT NOT NULL,
          urgency        TEXT NOT NULL DEFAULT 'ACTION',

          -- Who is speaking. Either may be null: the system speaks too.
          from_terminal_id   TEXT,
          from_terminal_name TEXT,
          from_user_id       TEXT,
          from_user_name     TEXT,

          -- Who should hear it. A list of terminal types, and/or one terminal
          -- by id. Empty audience means everybody who may see notifications.
          to_terminal_types  TEXT NOT NULL DEFAULT '[]',
          to_terminal_id     TEXT,
          -- Only stations whose holder has this permission are told.
          to_permission      TEXT,

          -- What it is about, so a tap can open the thing itself.
          order_id       TEXT,
          table_id       TEXT,
          table_label    TEXT,

          -- A key and its parameters, never a sentence: the kitchen screen is
          -- in Turkish and the floor's phone is in Arabic, from one row.
          message_key    TEXT NOT NULL,
          params_json    TEXT NOT NULL DEFAULT '{}',
          -- Free text a person typed, when there is any.
          body           TEXT,

          created_at         TEXT NOT NULL,
          acknowledged_at    TEXT,
          acknowledged_by    TEXT,
          acknowledged_name  TEXT
        );
        -- The question every terminal asks on connect: what is still open?
        CREATE INDEX idx_notifications_open
          ON notifications(created_at DESC) WHERE acknowledged_at IS NULL;
        CREATE INDEX idx_notifications_order ON notifications(order_id);
      `);
    },
  },
];
