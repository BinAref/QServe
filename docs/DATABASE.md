# Database

Two databases, deliberately separate, that never share a row.

| | restaurant server | licence server |
|---|---|---|
| where | the restaurant's own PC | the vendor, once, centrally |
| holds | menu, tables, orders, payments, staff, audit | licences, restaurants, devices, transfers |
| never holds | vendor keys, other restaurants | menu, orders, prices, diners, reports |
| engine | SQLite, WAL, `synchronous = FULL` | SQLite |

The separation is a requirement, not an optimisation: a restaurant's operational
data never leaves its own premises.

---

## 1. Conventions

- **Time** is ISO-8601 UTC text. Sortable as text, readable in a raw dump.
- **Money** is an integer of minor units. Floating point never touches a price.
- **Booleans** are `0`/`1`.
- **Localised text** is a JSON column, `{"en": "Burger", "ar": "برجر"}`. It is
  always read whole, written whole, and never queried by language, so a
  translations table would add joins and buy nothing.
- **Ids** are prefixed and sortable: `ORD-01M1VXT…` encodes its creation time,
  so ordering by primary key orders by time and keeps indexes cache-friendly.
- **Migrations** are forward-only and apply at boot, because nobody is on site
  to run a migration tool. Each runs in its own transaction: an upgrade that
  fails at step 7 keeps steps 1–6 and resumes there next boot.

---

## 2. Restaurant schema

```
                      ┌───────────────┐
                      │  restaurant   │ exactly one row
                      │  (Restaurant  │ owns everything below
                      │      ID)      │
                      └───────────────┘
                              │
   ┌──────────┬───────────────┼───────────────┬───────────────┐
   ▼          ▼               ▼               ▼               ▼
┌───────┐ ┌─────────┐   ┌───────────┐   ┌──────────┐   ┌──────────┐
│ users │ │  roles  │   │ terminals │   │categories│   │ settings │
└───┬───┘ └────┬────┘   └─────┬─────┘   └────┬─────┘   └──────────┘
    │  user_roles │            │              │
    └─────────────┘            │              ▼
                               │         ┌──────────┐   ┌────────┐
                    ┌──────────┴───┐     │ products │──▶│ addons │
                    ▼              ▼     └────┬─────┘   └────────┘
             ┌──────────────┐  ┌──────────┐   │
             │dining_tables │  │ terminal │   ▼
             │ (TABLE-05)   │  │ sessions │  product_options
             └──────┬───────┘  └──────────┘   └── option_choices
                    │
                    ▼
              ┌──────────┐      ┌─────────────┐      ┌──────────┐
              │  orders  │─────▶│ order_items │─────▶│selections│
              └────┬─────┘      └─────────────┘      │ + addons │
                   │                                 └──────────┘
                   ▼
              ┌──────────┐   ┌──────────┐   ┌───────────┐   ┌─────────┐
              │ payments │   │audit_log │   │ printers  │   │ backups │
              └──────────┘   └──────────┘   └─────┬─────┘   └─────────┘
                                                  └── print_jobs
```

### Decisions worth explaining

**A table is a terminal.** `dining_tables.terminal_id` references a `TABLE`
terminal. Tables and stations therefore share one QR pipeline, one session
mechanism and one permission model. Adding a new station type later needs none
of that built again.

**Orders are history, not a view of the menu.** `order_items` copies the
product's name and unit price at the moment of ordering. Re-pricing a burger
tomorrow does not change what a diner was charged today, and a product deleted
next month still prints correctly on last month's receipt. `orders.table_label`
is denormalised for the same reason.

**Accountability is columns, not prose.** `created_by_*`, `served_by_*`,
`paid_by_*` — each storing both the person and the station — and the same on
`payments`. Foreign keys enforce that these reference real users and terminals;
a test confirmed this by having an invented terminal id rejected.

**`visible` and `available` are different things.** `visible` is the menu-design
switch. `available` is today's 86 list. A sold-out dish can be shown greyed
rather than vanishing mid-meal.

**The audit log is append-only.** No code path updates or deletes a row.

**Exactly-one-row tables** use `singleton INTEGER PRIMARY KEY CHECK (singleton = 1)`,
so a second restaurant row is impossible rather than merely unexpected.

### Order numbering

`orders(business_day, order_number)` is unique. The business day rolls at 04:00
local time, so a restaurant trading past midnight does not split one service
across two report days. Numbering resets daily by default (`orders.dailyNumberReset`).

---

## 3. Licence-server schema

```
restaurants ──┬── licenses ──┬── activations   (history; released_at IS NULL = live)
              │              ├── transfers     (each paid move, with fee reference)
              │              └── audit_log
              └── signing_keys   (PUBLIC halves only)
                  admin_users / admin_sessions
                  vendor_settings (contact details and both prices, as free text)
```

The single most important line in the whole schema:

```sql
CREATE UNIQUE INDEX idx_activations_live
  ON activations(license_id) WHERE released_at IS NULL;
```

A partial unique index makes "at most one live device per licence" a property of
the storage engine. Two machines cannot run one licence even if the service
logic were wrong.

`licenses.key_hash` stores `SHA-256(key)`; the plaintext is shown once and never
stored. `key_hint` keeps the last five characters so support can identify a
caller's key without holding it.

Activation rows are **never deleted**. Releasing a device sets `released_at` and
a reason, so the full history of which machine held a licence, and why it
stopped, is permanent.

---

## 4. What a backup carries

Twenty-six tables: the restaurant, its settings and counters, roles and grants,
users, terminals, tables, the whole menu, assets, orders and their items,
payments, printers, print jobs, the audit log, and the languages and themes the
restaurant authored for itself (`custom_locales`, `custom_themes`) — a
restaurant that translated its entire menu into French must not lose that work
when the computer is replaced.

Deliberately excluded: `user_sessions` and `terminal_sessions` (a restore must
not resurrect a signed-in tablet), `license_state`, and `schema_migrations`. The
app-lock passphrase hash lives in `settings` and therefore *does* travel, which
is intended: restoring a restaurant restores the lock it chose.
Also outside the database entirely, and therefore outside every backup: the
install id, the activation certificate and the licence key.

That is what makes restoring on new hardware bring the restaurant across but not
the entitlement — see [LICENSING.md](LICENSING.md).

---

## 5. Inspecting a live installation

```bash
sqlite3 data/restaurant/restaurant.sqlite

.tables
SELECT restaurant_id, json_extract(name_json,'$.en') FROM restaurant;
SELECT order_number, status, source, created_by_user_name, total_minor
  FROM orders ORDER BY rowid DESC LIMIT 10;
SELECT at, action, actor_user_name, actor_terminal_name
  FROM audit_log ORDER BY rowid DESC LIMIT 20;
```

Read-only queries are safe while the server is running — that is what WAL mode
is for. Do not write to it behind the server's back; every write in the product
goes through a service that also audits and broadcasts.
