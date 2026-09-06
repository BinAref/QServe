# Security

This document states what QServe protects, how, and — just as importantly —
what it does **not** protect. The spec asks for "strong, reasonable commercial
protection", explicitly not for a claim of unbreakability. Nothing here claims
the licensing cannot be defeated by someone determined and technical with
physical access to their own machine. It claims that ordinary copying,
tampering and casual sharing fail cleanly, and that a restaurant's data and
money are handled properly.

---

## 1. Key material

| key | lives | ships in the app |
|---|---|---|
| Ed25519 **private** signing key | licence server only, from a file or env var, mode 0600 | **never** |
| Ed25519 **public** keys | `apps/server/config/trusted-keys.json` | yes, by design |
| licence key (bearer secret) | shown once at issue; only `SHA-256` stored | no |

`npm run keygen` writes the private half to `secrets/` (git-ignored) and
*merges* the public half into the app's trust store. Merging matters: rotating a
key must leave previously issued certificates verifiable, or every restaurant
already in the field would fail its next boot. It refuses to overwrite an
existing private key without `--force`, and says why.

A distributed copy of the application therefore contains nothing that can mint a
licence.

---

## 2. Authentication and sessions

Two independent identities travel on every request:

- **Terminal** — which station this is. Established by scanning that station's
  QR; long-lived, because a kitchen screen is never signed out.
- **User** — which person is acting. Established by username + PIN; twelve-hour
  default.

Session tokens are 256-bit random values, stored **hashed** (`SHA-256`) so a
stolen database dump cannot be replayed against a running installation. Plain
SHA-256 is correct here: the token has full entropy, so there is nothing to
brute-force.

Staff secrets are hashed with **scrypt** (N=2¹⁵, r=8, p=1), self-describing so
the cost can be raised later without invalidating existing hashes. Login
verifies against a pre-computed dummy hash when the user does not exist, so a
wrong username and a wrong password take the same time to fail.

Rate limits: staff login 12 per 10 minutes per address+username; vendor console
login 10 per 15 minutes; licence activation 20 per 10 minutes per address. A
successful login resets the counter, so one typo does not punish a legitimate
user.

Disabling an account or changing its password deletes its live sessions
immediately, rather than waiting for expiry.

---

## 3. Authorisation

Permissions are **rows in a table**, not constants. The defaults seed the table
once at install and are never consulted again, so a restaurant that re-scopes
its CASHIER role gets exactly what it configured.

Every mutating route is guarded server-side. Hiding a button is a convenience,
never the control. The effective set is:

```
(terminal type ceiling ∪ terminal extras)  ∩  (union of the user's role grants)
```

Consequences worth stating explicitly:

- A kitchen QR opened on a manager's phone grants kitchen powers only.
- A table QR grants `menu.view`, `orders.create`, `orders.view` — and cannot be
  escalated, because the ceiling is not editable from the terminal.
- Payments additionally require `requireUser`: a station alone may see the till,
  but taking money needs a named person, because the receipt has to name them.
- Management routes are mounted **only** on the loopback listener. A diner
  holding an administrator's cookie still has no route to call.

---

## 4. Transport, and what is accepted about it

A restaurant LAN is plain HTTP. There is no certificate authority in a
restaurant, and forcing HTTPS with a self-signed certificate would produce a
browser warning on every diner's phone — training everyone to click through
security warnings, which is worse than the problem.

What this accepts: **someone already on the restaurant's Wi-Fi can observe LAN
traffic.** They would see menu content and order contents.

What limits the damage:

- The management console is loopback-only, so settings, users, backups and the
  licence are never on the wire at all.
- Card data is never handled by QServe; payments record a method and an amount,
  and card processing belongs to whatever terminal the restaurant already uses.
- Session cookies are `HttpOnly` and `SameSite=Lax`. The `Secure` flag is
  applied when the deployment actually terminates TLS
  (`QSERVE_LS_SECURE_COOKIES` on the vendor side).
- A restaurant that wants encryption on the floor should put the terminals on a
  separate SSID with client isolation, which is the standard remedy and does not
  require the diner to click through a warning.

Response headers set on every request: `nosniff`, `no-referrer`,
`X-Frame-Options: SAMEORIGIN`, and a Content-Security-Policy limited to `'self'`
with no external origins. The product must work with the internet unplugged, so
a page that tries to reach the network is a bug — the CSP makes it fail loudly.

---

## 5. Input handling

- Every route names the fields it accepts; there is no mass-assignment path.
- **All pricing is recomputed server-side** from the menu. A client sends
  product ids and quantities; a tampered phone on the restaurant Wi-Fi cannot
  order a steak for zero.
- Order `source` and `createdBy` come from the authenticated session, never from
  the request body — which is what makes "who took this order" trustworthy.
- A table terminal may order only for its own table; a mismatch is refused.
- Image uploads are checked by **magic bytes**, not by the declared
  content-type, and capped at 4 MB. SVG uploads containing `<script` or
  `javascript:` are rejected outright.
- Static file paths are resolved and confirmed to remain inside their root, so
  traversal attempts return 404 and reveal nothing about the filesystem.
- SQL is parameterised throughout. The few dynamic fragments are column names
  from fixed internal maps, never user input.

---

## 6. Backups

Backups are **AES-256-GCM** with a **scrypt**-derived key (N=2¹⁵). The header —
restaurant id, timestamp, KDF parameters, payload checksum — is authenticated as
associated data, so editing it in a hex editor invalidates the file rather than
succeeding quietly. The header is readable *without* the passphrase, which is
what lets an operator confirm which restaurant a file holds before overwriting
anything.

A wrong passphrase and a mutated file are indistinguishable at the GCM layer,
and are reported as one honest error rather than a guess.

**A backup never contains:** vendor signing keys (never on the machine at all),
the activation certificate, the licence key, or the install id. A recursive
check refuses to *write* a backup containing anything that looks like vendor key
material — because a restaurant will happily email a backup to support.

**A backup does contain** staff password hashes. They are scrypt hashes, and
losing them would mean re-enrolling every employee after a hardware failure.

Restore is one transaction: either every table is replaced or none is.
`defer_foreign_keys` re-checks every constraint at commit, so a backup with
dangling references is rejected rather than imported. A restore also ends every
session, including the operator's own — correct, since the user table has just
been replaced.

### Two trade-offs stated plainly

**Terminal QR secrets are stored recoverably, not hashed.** Hashing them would
mean a restored backup could not reproduce the codes already printed on the
tables — the exact reprinting the spec exists to prevent. So they are in the
database and in the backup. The judgement: anyone holding the database already
holds the menu, the orders and the takings; and a table's QR is physically on
the table anyway. Rotating a compromised code is one click.

**The automatic-backup passphrase is stored in the local database.** Automatic
backups cannot prompt for one. The value of backup encryption is protecting the
*exported file* once it is on a USB stick, in cloud storage or in an email —
which it still does. It is not protecting against an attacker who already has
the database. Manual backups take a passphrase that is never stored.

---

## 7. Audit trail

Append-only by construction: the repository exposes `record` and reads, and no
update or delete. Every order creation, status change, payment, refund, licence
action, settings change and user change is recorded with the actor, the station,
the timestamp, the client address and the before/after values.

Ordering is by `(at, rowid)`. The rowid tiebreaker is deliberate: several
actions routinely share a millisecond, and ids carry random suffixes, so
timestamp-only ordering could show an order's history out of sequence — the one
thing the audit trail exists to prevent.

---

## 8. What is out of scope

- **Physical access to the restaurant PC.** Someone with the machine has the
  database. Full-disk encryption is the operating system's job.
- **A determined technical user defeating licensing on their own hardware.**
  Signature verification runs in a process they control. The design makes casual
  copying, key sharing and database editing fail cleanly, and makes tampering
  visible; it does not claim more.
- **Card data.** Never handled.
- **Denial of service from inside the restaurant.** Someone on the Wi-Fi can
  flood the LAN listener. Rate limits blunt credential guessing, not bandwidth.

---

## 9. Reporting

Security issues should go to the vendor privately, not to a public tracker.
Include the app version from the licence screen and the Restaurant ID; never
include a backup file or a licence key.
