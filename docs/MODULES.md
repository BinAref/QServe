# Modules

Each module owns one bounded context: its storage, its rules, and its routes.
They talk through constructor arguments only, so any of them can be constructed
and tested alone.

---

## Core (`src/core/`)

| file | responsibility |
|---|---|
| `schema.ts` | the entire database, in one readable migration |
| `license-gate.ts` | SETUP vs OPERATIONAL, decided offline; publishes mode changes |
| `security.ts` | resolves terminal + user into an actor; the three guards |
| `event-bus.ts` | in-process publish/subscribe with a monotonic sequence |
| `realtime.ts` | WebSocket projection of the bus, authorised per event |
| `network.ts` | LAN addresses, a small mDNS responder, the QR base URL |
| `paths.ts` | on-disk layout — encodes what is and is not backed up |
| `app-lock.ts` | the optional console password: a middleware, not a screen |
| `repositories/` | access (users, roles, sessions), terminals, settings, audit, licence, packs |

---

## Operational modules (`src/modules/`)

### menu
Categories, products, options, choices, add-ons. Never licence-gated: a
restaurant owns what it typed before it paid. Lists are loaded with a fixed
number of queries regardless of size, because a 300-item menu renders on every
diner's phone.

### tables
Dining tables, each backed by a `TABLE` terminal. Table status is **derived**
from the open orders on it and re-broadcast after every change, so it cannot
drift from reality. The ordering of the derivation encodes what a floor manager
needs first: an unpaid bill outranks food being cooked.

### terminals
Provisioning and QR issuing for every station type, plus enrolment. The QR
encodes `Restaurant ID + Table/Terminal ID` over a stable mDNS host. A failed
scan — wrong restaurant, unknown target, bad secret — returns one
indistinguishable result, so a scanner learns nothing by probing.

### orders
The centre of the system. Prices server-side, takes `source` and `createdBy`
from the session rather than the body, enforces the state machine, writes the
audit trail, and re-derives table status. Also auto-advances a pre-paid order to
PAID once that becomes a legal step.

### payments
Capture, split payments, refunds. Requires an identified user, because the
receipt names them. Never forces an illegal status jump: money and food are
separate tracks.

### printing
Modular routing by document type and kitchen station, so "kitchen orders →
kitchen printer, receipts → cashier printer" is configuration. Three transports:
raw ESC/POS over TCP, a browser bridge for USB printers, and a spool directory.

### backup
AES-256-GCM containers with an authenticated header. Restore is one transaction.
See [SECURITY.md](SECURITY.md).

### reports
Sales, source split, payment methods, per-cashier takings, top products, CSV
export. Reads the same local database that took the orders — no warehouse, no
nightly export, no cloud.

### licensing
The only module that makes an outbound call, on five occasions, every one of
them started by a person pressing a button. It also caches the vendor's contact
details and prices so the licence screen still shows them offline. Everything
else is offline.

### translations / themes
Discover, validate and serve packs from `locales/` and `themes/`, with the
restaurant's own packs merged over them key by key. A pack that fails validation
is rejected and reported rather than half-loaded.

`translations/content.ts` is the catalogue of every text the owner typed —
category names, dishes, descriptions, options, choices, add-ons, station and
role names — as one flat map a translator can work through. Adding a
translatable field later is one entry in a table; the export, the import, the
coverage report and the console all pick it up.

`translations/authoring.ts` is the restaurant's copy → translate → paste loop;
`translations/shipping.ts` is the developer's, writing the files the product
ships with, and validating them strictly because a gap there is a gap
everywhere.

### assets
Content-addressed image storage with magic-byte checking. Refuses to delete an
image the menu still references.

---

## Adding a module

1. `src/modules/<name>/` with a repository and a service.
2. Construct it in `container.ts` and add it to `Services`.
3. Add its routes in `src/http/routes/` and mount them in `app.ts`.
4. If it needs storage, add a migration with the next version number — never
   edit an applied one.
5. If it emits realtime events, add them to the catalogue in
   `packages/shared/src/events.ts` with the permission they require.

Nothing else changes. No other module, no core file, no front-end.
