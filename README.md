# QServe — Local Restaurant Operating System

A complete, offline-first operating system for running a restaurant, sold under
a **perpetual licence**. Not a QR-menu app.

Everything a restaurant does all day — the menu, the tables, the orders, the
kitchen, the till, the printers, the reports — happens inside the restaurant, on
its own computer and its own Wi-Fi. The internet is needed only to activate or
move a licence.

```
Main restaurant PC                             Restaurant Wi-Fi
┌──────────────────────────┐        ┌──────────┬──────────┬──────────┬──────────┐
│ local server + database  │◀──────▶│ Customer │  Waiter  │ Cashier  │ Kitchen  │
│ console · LAN · realtime │        │    QR    │    QR    │    QR    │    QR    │
└──────────────────────────┘        └──────────┴──────────┴──────────┴──────────┘
             │
             └── internet ── only for licence activation / transfer
```

---

## Quick start

```bash
npm install
npm run build

# 1. Vendor side: generate a signing key and start the licence server.
npm run keygen -- --out secrets/signing-key.json
QSERVE_LS_SIGNING_KEY_FILE=./secrets/signing-key.json npm run start:license-server
#    → vendor console at http://localhost:8090/admin
#    → the first developer password is printed once; store it

# 2. Restaurant side, in another terminal.
npm start
#    → management console at http://127.0.0.1:7010
```

Open the console. It walks you through creating the restaurant, creating the
owner account, and building your **real** menu. Issue a licence key in the
vendor console, paste it into the licence screen, and the LAN server starts
immediately — with everything you just built intact.

```bash
npm run check       # build + validate language/theme packs + 113 tests
```

---

## The two modes

**SETUP** is not a demo. You create your real restaurant, your real menu, your
branding, your themes and languages, and none of it is thrown away.

```
Install → Create restaurant → Create owner → Build the real menu
        → Enter licence key → LICENSE ACTIVE → Full restaurant operation
```

What SETUP withholds is live service: tables, terminals, QR codes, orders,
kitchen, till, printing — and the **LAN web server itself**, which is not bound
at all until a licence is active. Locked sections stay visible in the console
with an explanation, so an owner can see what they are buying.

Full detail: [docs/LICENSING.md](docs/LICENSING.md).

---

## What is in the box

| | |
|---|---|
| **Management console** | loopback-only; setup, menu builder, tables, terminals, users and roles, printing, settings, backup, reports, audit, licence |
| **Diner menu** | opened by scanning the table QR; options, add-ons, notes, live order status |
| **Kitchen display** | live tickets with their source, per-station filtering, alerts that repeat until acknowledged |
| **Cashier till** | open orders, split payments, change due, refunds, receipt printing |
| **Waiter terminal** | floor plan with live table statuses; order for any table |
| **Printer bridge** | drives a USB printer from a spare tablet |
| **Vendor console** | issue, search, release, revoke, reinstate and transfer licences |

Plus: real RBAC, an append-only audit trail, realtime over WebSocket,
configurable sounds, encrypted backup and restore, modular print routing,
Arabic/English/Turkish with RTL, and five themes.

---

## The decisions that matter

**Restaurant ID owns the data — the device never does.** No table stores a
device fingerprint as an ownership key. Changing computers means restoring a
backup, not rebuilding a menu.

**The licence is verified offline.** At boot the installation checks an
Ed25519-signed certificate against public keys shipped in the app. There is no
heartbeat and no phone-home, so a vendor outage, a dead router or an unplugged
cable cannot close a restaurant. The app contains only public keys; nothing in a
distributed copy can mint a licence.

**"No local server before activation" is enforced by the OS.** The LAN listener
is not bound in SETUP mode. There is no socket to bypass.

**Order source is taken from the session, never the request body.** `Source:
WAITER — Ahmed` next to `Source: CUSTOMER` on the kitchen board is something a
manager can rely on.

**Permissions are the intersection of station and person.** A kitchen QR opened
on a manager's phone grants kitchen powers, not manager powers. Payments
additionally require a signed-in human, because the receipt has to name them.

**Prices are always recomputed server-side.** A client sends product ids and
quantities. A tampered phone on the Wi-Fi cannot order a steak for zero.

**QR codes encode `Restaurant ID + Table ID`** over an mDNS name derived from the
Restaurant ID (`qserve-rest-000123.local`). Replace the computer, restore the
backup, and every printed table card still works. A test asserts it.

**Backups carry the restaurant but not the entitlement.** The certificate, the
licence key and the install id live outside the database, so a restored folder
can never clone a licence — moving machines stays a transfer.

**Adding a language or a theme is adding a file.** Both are validated by CLI
tools that fail on missing, invalid, duplicate or unsupported keys, and on
missing design tokens. No colour or font size is written in any stylesheet.

---

## Layout

```
packages/shared   pure vocabulary: state machine, permissions, capabilities,
                  money, pack schemas — no I/O, shared by servers and browsers
packages/crypto   every cryptographic operation, in one reviewable surface
packages/db       SQLite connection, migrations, column codecs
packages/http     small router, middleware, static handler, rate limiter
apps/server       the restaurant server
apps/license-server  the vendor's licensing service
apps/web          six front-ends, plain ES modules, no build step
locales/          ar · en · tr   (add a language = add a file)
themes/           light · dark · modern · classic · elegant
tools/            pack validators, for CI
docs/             architecture, database, licensing, security, modules, extending
```

Runtime dependencies, in total: `better-sqlite3`, `ws`, `qrcode`. No HTTP
framework and no front-end bundler — a restaurant PC should never need a
toolchain to serve its own menu.

---

## Configuration

Copy `.env.example`. The values worth knowing:

| variable | default | |
|---|---|---|
| `QSERVE_DATA_DIR` | `./data/restaurant` | database, assets, backups, licence |
| `QSERVE_ADMIN_PORT` | `7010` | console, **loopback only** |
| `QSERVE_LAN_PORT` | `7020` | diners and staff; bound only when licensed |
| `QSERVE_LICENSE_SERVER_URL` | `http://localhost:8090` | vendor endpoint |
| `QSERVE_PUBLIC_HOST` | mDNS name, else the LAN IP | host baked into printed QR codes |
| `QSERVE_VENDOR_WHATSAPP` | — | the "Request a licence" button |

Binding the admin console to anything but loopback prints a loud warning at
boot, and is not recommended.

---

## Documentation

| | |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | the shape of the system and why each boundary is where it is |
| [DATABASE.md](docs/DATABASE.md) | both schemas, conventions, and the decisions behind them |
| [LICENSING.md](docs/LICENSING.md) | SETUP vs OPERATIONAL, the certificate, what is charged |
| [SECURITY.md](docs/SECURITY.md) | what is protected, how, and what is **not** |
| [MODULES.md](docs/MODULES.md) | module responsibilities and how to add one |
| [EXTENDING.md](docs/EXTENDING.md) | languages, themes, terminal types, roles, printers, modules |

---

## Quality checklist

The spec sets these as the bar for "complete". Each is enforced, and most are
covered by a test:

- [x] No hard-coded languages — 376 keys in `locales/*.json`, validated
- [x] No hard-coded themes — 57 design tokens in `themes/*.json`, validated
- [x] Restaurant data never bound to one device
- [x] Daily operation never depends on the internet
- [x] No local web server before activation — the socket is not bound
- [x] One licence can never be live on two devices — enforced by a unique index
- [x] Backup and restore, encrypted and authenticated
- [x] Append-only audit trail with actor, station and before/after values
- [x] Real permission system, checked server-side on every mutating route
- [x] Realtime local communication; no polling
- [x] Every order carries a persisted, unspoofable source
- [x] Waiter, cashier and manager identity recorded on every action
- [x] Terminal IDs, and QR codes for tables and stations
- [x] Configurable sound notifications per terminal
- [x] Signing keys protected; only public keys ship in the app
- [x] Licence server holds no restaurant operational data
- [x] RTL and LTR
- [x] A new language, theme, terminal type or module is additive

---

## Licence

Proprietary. All rights reserved.
