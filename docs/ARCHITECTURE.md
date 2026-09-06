# Architecture

QServe is a **local, offline-first restaurant operating system**. The daily
running of a restaurant happens entirely inside the restaurant, on its own
computer and its own Wi-Fi. The internet is needed only to activate or move a
licence.

This document explains the shape of the system and, more importantly, *why* each
boundary is where it is.

---

## 1. The physical picture

```
                        ┌──────────────────────────────────────────┐
   internet ─── only ──▶│  License Server (vendor, one instance)   │
   for licensing        │  licences · restaurants · devices        │
                        │  no menu, no orders, no prices, no diners│
                        └──────────────────────────────────────────┘
                                        ▲
                                        │  activate / deactivate / status
                                        │  (a handful of calls per lifetime)
┌───────────────────────────────────────┼──────────────────────────────────────┐
│ RESTAURANT PREMISES                   │                                       │
│                                       │                                       │
│   ┌───────────────────────────────────┴───────────────────────────────────┐   │
│   │  Main Restaurant PC — one Node process                                │   │
│   │                                                                       │   │
│   │   admin listener  127.0.0.1:7010   management console (owner only)    │   │
│   │   LAN listener    0.0.0.0:7020     diners + staff — started only      │   │
│   │                                    when the licence is ACTIVE          │   │
│   │   WebSocket /ws                    realtime events                     │   │
│   │   SQLite                           the operational database            │   │
│   │   mDNS responder                   qserve-rest-000123.local            │   │
│   └───────────────────────────────────────────────────────────────────────┘   │
│                                       │ Wi-Fi / LAN                            │
│      ┌───────────────┬────────────────┼────────────────┬───────────────┐      │
│   Table QR        Waiter QR       Cashier QR       Kitchen QR      Printer QR  │
│   (diner phone)   (staff phone)   (till)          (KDS screen)     (bridge)    │
└───────────────────────────────────────────────────────────────────────────────┘
```

If the internet is unplugged, everything inside the premises keeps working:
menu, orders, kitchen, till, printing, tables, database, reports. Nothing on the
serving path makes an outbound request — there is no heartbeat, no phone-home
and no licence check at boot (see [LICENSING.md](LICENSING.md)).

---

## 2. Two listeners, one process

This is the single most important structural decision in the system.

| | admin | lan |
|---|---|---|
| bind address | `127.0.0.1` | `0.0.0.0` |
| audience | the owner, on the restaurant's own PC | diners and staff devices |
| running in SETUP | yes | **no — the socket does not exist** |
| routes | everything, including settings, users, backup, licence | menu, orders, terminals, payments, printing |

The spec requires that no local web server runs before licence activation. That
is enforced by *not binding the socket*, rather than by a check inside a
handler: before activation there is no port for a diner's phone to reach. When a
licence is activated the gate publishes a mode change and the LAN listener binds
immediately, with no restart; deactivating closes it again.

Management routes are mounted only on the admin router. Even if a diner somehow
obtained an administrator's session cookie, there is no route on the LAN
listener that could act on it.

---

## 3. Packages and applications

```
packages/
  shared/     pure, runtime-neutral vocabulary — imported by the servers AND
              validated against the browser mirror. No I/O, ever.
  crypto/     every cryptographic operation, in one reviewable surface
  db/         SQLite connection, migration runner, column codecs
  http/       small router, middleware chain, static handler, rate limiter

apps/
  server/          the restaurant server (runs on the restaurant PC)
  license-server/  the vendor's licensing service (runs once, centrally)
  web/             the six front-ends, plain ES modules, no build step

locales/     one file per language   (adding a language = adding a file)
themes/      one file per theme      (adding a theme    = adding a file)
tools/       validators for both, runnable in CI
```

`@qserve/shared` is deliberately dependency-free and I/O-free. It holds the
order state machine, the permission catalogue, the capability set, money
arithmetic and the pack schemas — the rules that must mean the same thing on the
server, in the vendor console and on a diner's phone.

---

## 4. Module boundaries inside the restaurant server

```
src/
  core/                     things every module needs
    schema.ts               the whole database, in one readable migration
    license-gate.ts         SETUP vs OPERATIONAL, decided offline
    security.ts             actor resolution + authorisation middleware
    event-bus.ts            in-process publish/subscribe
    realtime.ts             WebSocket projection of the bus
    network.ts              LAN addresses, mDNS responder, QR base URL
    paths.ts                on-disk layout (what is and is not backed up)
    repositories/           access, terminals, settings, audit, licence

  modules/                  one directory per bounded context
    menu/  tables/  orders/  payments/  terminals/  printing/
    backup/  reports/  licensing/  translations/  themes/  assets/

  http/routes/              the API, grouped by audience
  container.ts              the entire dependency graph, in one file
  app.ts                    listeners, routers, lifecycle
```

Modules depend on each other only through constructor arguments. There is no
service locator and no import-time singleton, which is what lets each module be
tested on its own — `apps/server/src/tests/harness.ts` builds a complete
installation in a temp directory with no network and no HTTP.

Adding a module means adding a directory, constructing it in `container.ts`, and
mounting its routes. Nothing else changes.

---

## 5. Request lifecycle

```
request
  → security.authenticate()     resolve terminal + user from cookies
  → requireCapability(cap)      does the LICENCE allow this at all?      402
  → requirePermission(p)        does this SESSION allow this?            403
  → requireUser(p)              is a PERSON accountable for this?        401
  → handler                     validate → service → repository
  → AppError                    stable code + translation key, never prose
```

The three guards answer three genuinely different questions, in the order that
gives the clearest failure:

- **Capability** — commercial. "This installation has not been licensed for
  live service." Answers `402` with the capability name, which the console turns
  into an *activate your licence* panel rather than a generic error.
- **Permission** — organisational. "A cook may not issue refunds."
- **User** — accountability. Payments and settings need a named human, because
  the receipt and the audit log have to say who.

### Effective permissions

```
effective = terminal type ceiling ∪ terminal extras     (what this STATION may do)
            ∩ union of the user's role grants           (what this PERSON may do)
```

The intersection is the point. Scanning a kitchen QR on a manager's phone yields
kitchen powers, not manager powers — the station cannot be escalated by who is
holding it, and the person cannot be escalated by where they stand.

---

## 6. Realtime

The server owns an in-process `EventBus`. Services publish domain facts to it;
the WebSocket gateway is a thin projection onto connected sockets. Terminals
never poll.

Three properties make it safe to run a kitchen on:

- **Authorisation per event.** Every event names a permission in the catalogue.
  A kitchen screen is not merely *not shown* payment totals — it is never sent
  them.
- **Sequence numbers.** A terminal that reconnects compares the server's
  sequence with its own. On a gap it reloads from the API instead of applying
  increments to a stale board.
- **Honest connection state.** While the socket is down, every staff screen
  shows a banner. A silently stale kitchen display is how food gets lost.

---

## 7. Data ownership

**The Restaurant ID owns the data. The device never does.**

No table stores a device fingerprint as an ownership key. Replacing the computer
means restoring a backup, not rebuilding a menu. Six identities are kept
strictly separate, with branded TypeScript types so they cannot be passed for
one another:

| identity | example | lifetime |
|---|---|---|
| Restaurant ID | `REST-000123` | forever; survives every hardware change |
| License ID | `LIC-2026-000123` | the commercial entitlement |
| Device Fingerprint | 64 hex chars | the *current* PC only |
| Terminal ID | `TERM-8RZF5VYYQA` | a station |
| Table ID | `TABLE-05` | a table |
| User ID | `USR-8BEZ6W24MZ` | a person |

The on-disk layout encodes the same split:

```
data/restaurant/
  restaurant.sqlite     restaurant data      → in every backup
  assets/               menu images          → in every backup
  install-id            THIS machine         → never backed up
  license/certificate   THIS machine         → never backed up
  license/key           bearer credential    → never backed up
```

Restoring a backup on new hardware therefore brings the restaurant across but
not the entitlement, so moving machines is a licence transfer rather than a
clone. That is a property of the file layout, not of a policy check.

---

## 8. Why these technology choices

**SQLite.** The operational store lives on one restaurant PC, must survive that
PC losing power mid-service, and must never need a DBA. WAL mode gives
concurrent readers — the kitchen screen, the till, a dozen diners' phones —
while a write is in flight. `synchronous = FULL` trades throughput for
durability: a restaurant losing the last order to a power cut is not acceptable.

**No HTTP framework.** The router, middleware chain and static handler are about
400 lines. In exchange, the request lifecycle that enforces licensing and
permissions is readable end to end, and the supply chain of a product installed
on machines nobody administers stays tiny. Runtime dependencies total three:
`better-sqlite3`, `ws`, `qrcode`.

**No front-end bundler.** The terminals are plain ES modules served directly.
There is no build to run on a restaurant PC and no toolchain to install. The
cost is a hand-written mirror of the domain constants in
`apps/web/shared/events.js` — which a test pins against `@qserve/shared`, so it
cannot drift unnoticed.

**Synthesised alert sounds.** Web Audio rather than audio files: nothing to
download, nothing to lose in a backup, and a restaurant's own recording drops in
later through the same code path.

---

## 9. Extending the system

See [EXTENDING.md](EXTENDING.md). In summary, each of these is additive:

| to add | do this | core changes |
|---|---|---|
| a language | drop a file in `locales/` | none |
| a theme | drop a file in `themes/` | none |
| a terminal type | one entry in `TerminalType` + its permission ceiling | none |
| a role | create it in the console | none |
| a printer | configure it; routing is data | none |
| a module | a directory + a line in `container.ts` | none |
