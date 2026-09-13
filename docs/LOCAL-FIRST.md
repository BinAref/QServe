# Local first, and what that commits us to

The restaurant's data lives on the restaurant's computer. Everything the
restaurant does happens there, with no internet involved. Two things reach
outside, both of them rare and both of them started by somebody pressing a
button: activating a licence and cancelling one.

This document maps that arrangement onto the code, so that a change which
quietly breaks it is a change somebody has to argue for.

## Where the data is

    apps/server/src/core/schema.ts        the restaurant's own SQLite
    data/restaurant/restaurant.sqlite     one file, on the restaurant's machine

There is no cloud copy of a restaurant's menu, orders, tables, prices, staff or
takings. The vendor's Supabase project holds licences and nothing else — no
menu, no order, no product, no price, no diner — and the schema comment in
`supabase/migrations/…_licensing.sql` says so where somebody adding a table
would read it.

## Where the menu is served

    apps/server/src/app.ts                two listeners, deliberately unalike
    apps/server/src/core/network.ts       finding this machine on the network

The console binds to loopback. The restaurant's own Wi-Fi gets a second
listener carrying the staff terminals and the diner's menu. A diner's phone
reaches the menu over that Wi-Fi and nothing leaves the building:

    Customer phone → restaurant Wi-Fi → this computer → local HTTP server → SQLite

Neither the address nor the port is fixed. `lanAddresses()` reads the machine's
current addresses, `publicBaseUrl()` chooses one, and the QR image is generated
from that at the moment it is asked for.

**One deliberate difference from the obvious design.** The QR prefers the
mDNS name — `qserve-rest-000123.local` — over a raw IP address. A printed
table card outlives the router's idea of which IP this machine should have, and
a card that stops working because the router rebooted is a card somebody has to
reprint for every table. Where mDNS cannot advertise, the current IP is used
instead, and those cards do need reprinting if the address changes.

## The three surfaces

    apps/server/src/http/access.ts               named, with what each may do
    apps/server/src/tests/access-surfaces.test.ts   and a test that holds them to it

| Surface | Reachable from | Writes | Management | Served now |
|---|---|---|---|---|
| `ADMIN` | this computer only | yes | yes | yes |
| `LAN` | the restaurant's Wi-Fi | yes | no | yes |
| `PUBLIC` | the internet, later | no | no | **no** |

`PUBLIC` exists now and serves nothing. It is a read-only menu built by taking
the menu and content routers and keeping only their GETs — not by adding a
permission check to the existing ones, because a surface facing the open
internet should not have an editing route behind a check, it should not have an
editing route.

It is here for one reason. Remote access is a later subscription, and when it
arrives the temptation will be to point a tunnel at the LAN listener, which
already serves the menu. That listener also takes orders, enrols terminals and
serves the staff applications; publishing it would put all of that on the
internet. The test names the routes that must never appear there.

## Remote access, when it comes

    Customer → internet → Cloudflare → this restaurant's hostname
             → its own tunnel → cloudflared → local HTTP server → SQLite

Remote is an **access layer onto the local database**, not a copy of it in the
cloud. Nothing about it moves a restaurant's data anywhere.

Three settings hold what an installation would need to know, and they ship off:

    remote.status      DISABLED · TRIAL · ACTIVE · EXPIRED · SUSPENDED
    remote.hostname    e.g. r001.menu.binaref.com
    remote.expiresAt

They are bookkeeping. Nothing in the operational path reads them, and the test
above asserts that an expired remote subscription changes not one local
capability — because an expired subscription is not a reason for a till to stop
taking money. The licence gate decides what a restaurant may do and has never
heard of these keys.

## Two licences, sold separately

The application licence is **lifetime**. Once activated, the certificate is
verified against public keys shipped inside the build, offline, forever:
`packages/crypto/src/certificate.ts`. There is no heartbeat, no phone-home and
no check at boot.

**What that costs, stated plainly.** A machine that never touches the internet
again cannot be reached. If the vendor deletes a licence, the installation
holding it learns so the next time it asks — which is only when somebody
presses activate or cancel. This is not an oversight to be fixed by adding a
check at startup; it is the same property that keeps a restaurant trading
through an outage, seen from the other side.

Remote will be an annual subscription, separate from the licence, and either
can be in any state without affecting the other:

    Licence: ACTIVE / LIFETIME        Remote: EXPIRED
    → the restaurant works completely; only access from outside has stopped.

## What this release contains

Local database, local HTTP server, local menu, local QR. No Cloudflare, no
tunnel, no remote subscription, and no per-restaurant setup beyond typing a
licence key.
