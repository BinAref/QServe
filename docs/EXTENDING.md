# Extending QServe

The spec asks that new languages, themes, devices, roles, features and
integrations can be added **without rebuilding the system**. This is the
practical guide. Each section ends with what you must *not* have to touch.

---

## 1. Add a language

There are two kinds of "add a language", and they are answers to two different
questions.

| | who | where it lives | how |
|---|---|---|---|
| **for one restaurant** | the owner | that restaurant's database | Console → Languages |
| **for the product** | the developer | `locales/<code>.json` | a file, or Console → Developer |

### 1a. A restaurant adds a language for itself

This is the common case and it needs no developer at all. **Console →
Languages → Add a language** walks through three steps:

1. **Copy the JSON.** Either the key list with empty values, or an existing
   language with its text to translate over.
2. **Translate it** — anywhere. A translator, a colleague, a chat window. There
   is no account, no API key and no integration, and it works with the internet
   unplugged for everything except the translating itself.
3. **Paste it back and save.**

What makes this a *whole* language rather than a translated frame is what the
file contains. Alongside the interface strings, it carries **every word the
owner ever typed**: the restaurant's name, category names and descriptions,
product names and descriptions, option names, every choice, add-ons, station
names and role names. Keys are `kind:id:field`, so a re-export after the menu
grows lines up with the previous one.

```json
{
  "$schema": "qserve.translation.bundle.v1",
  "locale": "fr", "name": "Français", "direction": "ltr", "sourceLocale": "en",
  "ui":      { "common.save": "Enregistrer", "nav.menu": "Carte" },
  "content": {
    "product:PRD-01M1W:name": "Kofta d’agneau",
    "option:OPT-01M1W:name":  "Niveau d’épices",
    "choice:CHO-01M1X:name":  "Doux"
  }
}
```

Pastes **merge**, in both halves. A partial translation is safe: keys left blank
keep what they had, keys not mentioned are untouched, and anything still missing
falls back — a menu grows between exports, and a half-finished translation must
never undo a finished one.

A restaurant pack for a language QServe already ships overrides only the keys it
defines, so correcting one wording costs nothing else. Restaurant-authored
languages live in `custom_locales` and travel in the encrypted backup, because a
restaurant that translated its whole menu into French must not lose that work
when the computer is replaced.

**You do not touch:** anything. This is a screen, not a deployment.

### 1b. The developer adds a language to QServe

Adding a language to the product is adding one file.

```bash
cp locales/en.json locales/fr.json
```

Edit the header and translate the values:

```json
{
  "$schema": "qserve.locale.v1",
  "locale": "fr",
  "name": "Français",
  "englishName": "French",
  "direction": "ltr",
  "fallback": "en",
  "strings": { "app.name": "QServe", "common.save": "Enregistrer" }
}
```

Validate before shipping:

```bash
npm run validate:i18n          # missing, invalid, duplicate, unsupported keys
node tools/validate-i18n.mjs --strict   # demand 100% coverage, for CI
```

Restart the server and enable the language in **Settings → Available to diners**.

The same thing without leaving the browser: start with `QSERVE_DEVELOPER_MODE=true`
and use **Console → Developer**, which offers the identical copy → translate →
paste loop and writes `locales/<code>.json` for you. It is off in every packaged
build, so a restaurant's console has no such section and the routes 404.

One difference from 1a is deliberate: a **shipped** pack is validated strictly. A
missing key in a restaurant's own language falls back; a missing key in a shipped
pack would be missing in every restaurant on earth, so it is refused rather than
warned about.

Notes that save time:

- `locale` must equal the filename, or the pack is rejected.
- Keys are strictly lower-snake dotted (`orders.action.accept`). Enum-derived
  keys are lowercased: `t('orders.status.' + status.toLowerCase())`.
- A partial translation is fine — the server merges each pack over its fallback
  chain and serves one complete dictionary, so every screen still renders.
- `direction: "rtl"` is the entire cost of a right-to-left language. Every
  stylesheet uses logical properties (`margin-inline`, `inset-inline-start`),
  so there is no mirrored CSS to write.
- Placeholders must match the reference exactly. The validator catches a
  dropped `{number}` — otherwise every ticket would print "Order #".

**You do not touch:** any TypeScript, any stylesheet, any front-end.

---

## 2. Add a theme

Same two kinds, same two answers. A restaurant adds a theme for itself in
**Console → Themes** — copy a theme, change its colours, paste it back — and it
lives in `custom_themes` and travels in the backup. The developer adds one to
the product as a file (or in **Console → Developer**):

```bash
cp themes/light.json themes/coastal.json
```

Set `id` to the filename, choose `colorScheme`, and edit the tokens. Tokens may
reference each other, so a palette change touches one line:

```json
{ "component": { "nav": { "background": "{color.surface}" } } }
```

```bash
npm run validate:themes
```

The validator checks all 57 required tokens are present, that references
resolve, and that none are circular. A theme that passes is guaranteed to render
every screen, because the front-ends may use only those paths.

**You do not touch:** any code. Themes are served as CSS custom properties and
applied at runtime.

---

## 3. Add a currency

**Console → Currencies → Add a currency.** Write the code and the symbol —
`TRY` and `₺`, `USD` and `$` — say how many decimal places it has and which
side the symbol sits, and give what one unit is worth in the base. Every price
field on the menu then offers it.

One currency is the **base**: what the till counts, what the reports add up,
what a bill settles in. A partial unique index makes "exactly one base" a
property of the storage engine rather than a rule somebody can forget.

Three decisions worth knowing, because they are what keep the money honest:

- **A dish's options and add-ons are in the dish's own currency.** A "large"
  that costs 5 more costs 5 of whatever the dish is priced in, so one currency
  governs a whole order line and there is nothing to pick twice.
- **Every order line stores the rate it used.** A bill printed last month does
  not change because the rate moved this morning — the line keeps its currency,
  its price, the rate, and the converted amount, all four.
- **Totals are always in the base.** Tax, service and the amount the till takes
  have to be one number in one currency, whatever the lines were priced in.

Moving the base re-expresses every other rate in the same transaction, so no
price silently changes meaning. A currency still priced on the menu cannot be
deleted; the screen says how many dishes hold it.

**You do not touch:** any TypeScript, any stylesheet, any front-end.

---

## 4. Add a terminal type

Say a `SOMMELIER` station.

1. `packages/shared/src/enums.ts` — add `SOMMELIER: 'SOMMELIER'` to `TerminalType`.
2. `packages/shared/src/permissions.ts` — add its ceiling to
   `TERMINAL_TYPE_CEILING`. This is the maximum that station can ever do,
   whoever signs in on it.
3. `packages/shared/src/sound.ts` — optionally add a case to
   `defaultSoundProfile`.
4. `apps/server/src/modules/terminals/service.ts` — add its landing path to
   `LANDING_PATH`.
5. `apps/web/shared/events.js` — mirror the enum value (a test enforces this).
6. `locales/*.json` — add `terminals.type.sommelier`.
7. Build a front-end at `apps/web/sommelier/`, or point it at an existing one.

Provisioning, QR issuing, enrolment, sessions, permissions and realtime routing
all work immediately.

**You do not touch:** the database schema, the QR pipeline, the session
mechanism, the router.

---

## 5. Add a role

Entirely at runtime, in **Users → Roles → Add role**. Pick a key, a name and the
permissions. Roles are rows; the built-in defaults seed the table once at
install and are never consulted again, so re-scoping `CASHIER` gives exactly
what you configured.

To add a new *permission*, add it to `Permission` in
`packages/shared/src/permissions.ts`, mirror it in `apps/web/shared/events.js`,
and guard the route with it.

---

## 6. Add a printer

Configuration only, in **Printing**. Choose a transport:

| transport | target | for |
|---|---|---|
| `NETWORK` | `192.168.1.50:9100` | a normal network thermal printer |
| `BROWSER` | a terminal id | a USB printer on a tablet running `/printer` |
| `FILE` | a spool directory | whatever the restaurant already uses |

Then declare which document types it accepts and which kitchen stations it
serves. Routing is data: "kitchen tickets from the grill and fryer go here,
receipts go there" needs no code.

To add a new **document type**, extend `PrintDocumentType`, add a renderer next
to `renderKitchenTicket` / `renderReceipt`, and mirror the enum.

---

## 7. Add a module

```
apps/server/src/modules/<name>/
  repository.ts   all its SQL
  service.ts      its rules; no SQL, no HTTP
```

1. Construct it in `container.ts`; add it to the `Services` interface.
2. Add routes in `src/http/routes/` and mount them in `app.ts`. Mount on the
   admin router only unless a terminal genuinely needs it.
3. Storage: append a migration with the next version. **Never edit an applied
   migration** — installations in the field have already run it.
4. Realtime: add events to the catalogue in `packages/shared/src/events.ts` with
   the permission each requires. The gateway then routes and authorises them
   automatically.
5. Licence gating: if it is operational rather than authoring, add a
   `Capability` and guard the routes with `requireCapability`.
6. Add it to `BACKED_UP_TABLES` in the backup module if its data belongs to the
   restaurant.

---

## 8. The features the architecture is ready for

The spec lists these as future work, explicitly not to be built now. Each is
noted with where it would attach:

| feature | where it attaches |
|---|---|
| Bar, delivery, takeaway | new `TerminalType` + an `OrderSource`; the order model already carries both |
| Reservations | a new module; tables and their status already exist |
| Inventory / stock | a module subscribing to `order.created`; products already carry a station |
| Loyalty, customer accounts | a module; orders already record their source and actor |
| Multiple branches | each branch is a Restaurant ID with its own licence; the identity split already supports it |
| Online ordering | an `OrderSource.INTEGRATION` client against the existing order API |
| Cloud sync | a module subscribing to the event bus; nothing else assumes local-only |
| Payment integrations | a transport behind `PaymentService.capture` |
| Accounting export | reports already produce CSV |
| Extra KDS screens | create another `KITCHEN` or `KDS` terminal — no code |

The rule the spec sets, and this codebase follows: **build the architecture that
admits them, not the features themselves.**

---

## 9. Before you ship a change

```bash
npm run check      # build + validate packs + 113 tests
```

And re-read the quality checklist in the README: no hard-coded languages, no
hard-coded themes, no restaurant data bound to a device, no internet dependency
on the serving path, and no local web server before activation.
