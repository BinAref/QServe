# Licensing

QServe sells **perpetual licences**. A restaurant buys once, runs forever, and
pays again only if it moves the software to a different computer.

This document covers the commercial rules, the protocol, and the two modes an
installation can be in.

---

## 1. SETUP mode is not a demo

Before a licence is activated, an installation is in **SETUP**. This is a real
environment, not a trial:

- The owner creates their **real** restaurant, with its real name and branding.
- They build their **real** menu — categories, products, prices, options,
  add-ons, images, translations.
- They choose the theme and the languages diners will see.
- They can preview exactly what a diner will get.
- They can take an encrypted backup.

Every byte of it is kept. Activation does not reset anything, and the owner
never retypes a menu.

```
Install → Create restaurant → Create owner → Build the real menu
        → Enter licence key → LICENSE ACTIVE → Full restaurant operation
```

What SETUP withholds is **live service**:

| withheld until activation | why |
|---|---|
| the LAN web server | the socket is not bound; no phone on the Wi-Fi can reach anything |
| creating tables and their QR codes | these are operational assets |
| creating waiter / cashier / kitchen terminals | as above |
| accepting orders | |
| kitchen, cashier and waiter service | |
| operational printing | |
| operational reports | |

The console still shows every locked section, with a padlock and an explanation
of what activation unlocks. An owner deciding whether to buy should be able to
see what they are buying.

Gating is enforced in two independent places:

1. **Route level** — `requireCapability` answers `402 LICENSE_REQUIRED` carrying
   the capability name, so the UI can offer the activation screen.
2. **Listener level** — the LAN server is never bound. This is the stronger
   guarantee: there is no socket, so there is nothing to bypass.

---

## 2. Three identities, never conflated

| identity | example | belongs to | changes when |
|---|---|---|---|
| **Restaurant ID** | `REST-000123` | the restaurant | never |
| **License ID** | `LIC-2026-000123` | the entitlement | never |
| **Device Fingerprint** | 64 hex characters | the current computer | the computer changes |

The Restaurant ID owns all data. The device fingerprint owns nothing. That
separation is what makes a hardware change a support matter rather than a
disaster.

### The device fingerprint

The spec is explicit that a MAC address alone is not good enough, and it is
right: MACs are trivially spoofed and USB adapters come and go. The fingerprint
mixes independent signals:

- a **persisted install id**, random, generated once, stored outside the
  database and therefore never carried by a backup;
- the **OS machine id**, where the platform exposes one;
- **hardware traits** — CPU model, core count, memory rounded to whole
  gigabytes (so a RAM upgrade of the same class is tolerated);
- **permanent network interfaces**, sorted and de-duplicated, skipping the
  virtual adapters that container runtimes and VPN clients create.

Each component is also hashed individually. Vendor support can see *which* trait
changed when a restaurant calls about a failed activation, without ever learning
the raw values.

---

## 3. The activation certificate

Activation returns an **Ed25519-signed certificate** which the installation
stores and verifies **offline** from then on.

```json
{
  "alg": "Ed25519",
  "keyId": "b17cce233599b10c",
  "payload": "{…canonical JSON…}",
  "signature": "…base64url…"
}
```

The payload names the licence, the restaurant, the device, the activation, the
transfer count and the unlocked capabilities. `notAfter` is `null` for perpetual
licences — a test asserts a perpetual certificate still verifies in 2099.

Verification does **no I/O at all**. At boot the installation checks the
signature against public keys shipped inside the app, then checks the
certificate names this device and this restaurant. So:

- the licence server being down does not stop a restaurant trading;
- the internet being down does not stop a restaurant trading;
- the vendor going out of business does not stop a restaurant trading.

The application contains **only public keys**. Nothing in a distributed copy can
mint a licence. Keys are addressed by `keyId`, so the vendor can rotate without
invalidating certificates already in the field.

---

## 4. Licence keys

```
QSRV-4K7QM-9XTV2-BR5HN-P83WC
```

Twenty Crockford base-32 characters (no I, L, O or U, so a key survives being
read aloud) plus a checksum character. The checksum catches every single-typo
and adjacent transposition **offline**, before any network call. Input is
normalised aggressively: lower case, missing dashes, extra whitespace, and the
substitutions people actually make (`O`→`0`, `I`→`1`).

The licence server stores only `SHA-256(key)`. The plaintext is shown to the
vendor **once**, at issue, and is unrecoverable afterwards. A `key_hint` — the
last five characters — is kept so support can identify which key a caller holds
without the key being stored.

---

## 5. What is charged, and what is not

A partial unique index in the licence-server schema enforces the core commercial
rule at the storage layer: **at most one live device binding per licence**. Two
machines cannot run one licence even if the service logic were wrong.

| situation | outcome |
|---|---|
| first activation | **free** — included in the purchase |
| re-activating the same computer (reinstall, restore, OS repair) | **free**, idempotent |
| deactivating and coming back to the same computer | **free** |
| vendor revokes and later reinstates, same computer | **free** |
| activating a **different** computer | **transfer** — consumes a paid credit |
| activating while another device is live | refused (`ALREADY_ACTIVE_ELSEWHERE`) |
| a revoked licence | refused, permanently, until reinstated |

A transfer fee is for *moving hardware*. Activation compares the requesting
device against the machine that last held the licence, so a restaurant is never
billed for something it did not do.

### Moving to a new computer

```
1. Deactivate the old device        (console, or vendor-side if it is dead)
2. Pay the transfer fee             (vendor records it, granting one credit)
3. Restore the backup on the new PC (menu, tables, staff, history, QR codes)
4. Activate                         (consumes the credit; transfer_count += 1)
5. Trade                            same Restaurant ID, same printed QR codes
```

Step 3 and step 4 are independent by design. The backup carries the restaurant;
it deliberately does **not** carry the certificate, the licence key or the
install id, so a restored folder can never clone an entitlement.

If the old computer is dead, stolen or already sold and cannot deactivate
itself, the vendor releases it from the console. Every release is audited with a
reason.

---

## 6. Protocol

The restaurant server makes outbound calls on exactly five occasions, every one
of them started by a person pressing a button. Nothing else in the product ever
reaches the network.

| route | when |
|---|---|
| `POST /api/v1/activate` | first activation, transfer, re-activation |
| `POST /api/v1/deactivate` | before moving to another machine |
| `POST /api/v1/status` | a manual check from the licence screen |
| `GET /api/v1/public-keys` | out-of-band key pinning by an installer |
| `GET /api/v1/vendor-info` | the owner presses "refresh prices and contacts" |

Requests carry a nonce, echoed in the response; a mismatch is treated as a
failure rather than accepted. Activation is rate limited per source address.

When the licence server is unreachable, the failure is reported as
`LICENSE_SERVER_UNREACHABLE` with a message that says plainly that the
restaurant keeps working — because it does.

---

## 7. Requesting a licence, and paying for one

**The application handles no payment.** There is no card form, no checkout, no
payment provider, and no route anywhere in either server that moves money. A
restaurant that wants a licence talks to the vendor, pays however the two of
them agree, and is given a key to type in.

So the only thing the software needs to know is *who to contact and what to
expect to pay* — and both are the vendor's to write, in the vendor console:

| field | example | who writes it |
|---|---|---|
| vendor name and tagline | "QServe Gulf" | vendor |
| **activation price** | `1,500 SAR`, `٥٠٠ ر.س شامل التركيب` | vendor |
| **transfer price** | `150 SAR`, `first move within a year is free` | vendor |
| contacts | WhatsApp, phone, email, Telegram, website | vendor |
| how to buy | free text shown under the prices | vendor |

Prices are free text on purpose. A vendor selling in three countries can say
what is actually true, which a number and a currency code cannot. Left blank,
the restaurant is told to ask.

The restaurant fetches this once from `GET /api/v1/vendor-info` — public and
unauthenticated, because a restaurant in SETUP mode has no licence yet, and
that is exactly when it needs the phone number — and caches it in settings. A
restaurant deciding to buy is often a restaurant whose internet is not working,
which is why it bought an offline system; the cached prices stay readable, with
the date they were fetched shown beside them.

And before any of that has happened at all, the same details ship **inside the
build**, in `apps/server/config/vendor.json`. A restaurant that has just unzipped
QServe has never spoken to anything, and "ask us" naming nobody is not an answer
to "who do I pay". The developer prepares that file in the console's **Developer**
section, or the release workflow writes it from a repository secret; the licence
screen says *as shipped with this copy* so nobody mistakes it for a live quote,
and the first successful fetch replaces it. See
[PACKAGING.md](PACKAGING.md).

The licence screen then offers **"I have a licence key"** and a contact button
per channel. WhatsApp and Telegram links carry a prefilled message, composed in
the console from translation keys so it goes out in the owner's own language:

```
Hello, I would like a licence for QServe.
Restaurant: Al Bait Grill
Restaurant ID: REST-000123
Version: 1.0.0
Computer: kitchen-pc (windows/x64)
```

It carries only what the vendor needs to issue a key. No menu, no orders, no
customer data, no device secrets.

---

## 8. Vendor console

`/admin` on the licence server, protected by a scrypt-hashed password, server-
side sessions stored as hashes, and a rate limiter. There is no back door and no
hard-coded credential anywhere in the repository; the first account is created
at first boot from the environment, or generated and printed once.

The console can: search restaurants and licences, issue a licence (ids and key
material are generated — the developer never types cryptographic material),
release a device, revoke, reinstate, record a paid transfer, read the full
activation, transfer and audit history, and write the pricing and contact
details every restaurant sees on its licence screen (§7).

What it **cannot** do is see a restaurant's menu, orders, prices or diners —
because the licence server never receives them. There is no route that could.
