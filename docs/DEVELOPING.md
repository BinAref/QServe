# Working on QServe from your own computer

Everything is in the repository. Nothing lives only in a chat window, and
nothing has to be re-created: clone the branch and you have the whole product —
the server, the six front-ends, the licence server, the Windows packaging, the
Android app, the languages, the themes, the tests.

A restaurant that only wants to *run* QServe does not need any of this; it
downloads the Windows folder from the Releases page and runs `QServe.exe`. This
page is for changing the product.

---

## What you need

| | |
|---|---|
| **Node.js 22** | [nodejs.org](https://nodejs.org) — the LTS installer. This is what the build and the release runners use. |
| **Git** | [git-scm.com](https://git-scm.com) — on Windows the installer includes Git Bash, which is a comfortable place to run these commands. |

That is the whole list. There is no database to install, no Docker, no
framework: SQLite is a file, and the front-ends are plain ES modules that the
server serves as they are.

## Getting it

```bash
git clone https://github.com/BinAref/QServe.git
cd QServe
git checkout claude/local-restaurant-operating-system-a3nh73
npm ci
npm run build
```

`npm ci` installs from the lockfile, so you get exactly the versions the
release was built with. The one native module is `better-sqlite3`, which ships
a ready-made binary for Windows, macOS and Linux on Node 22 — if it ever tries
to compile instead, you are on a Node version it has no binary for, and moving
to 22 fixes it rather than installing a compiler.

## Running it

```bash
npm start
```

The management console is at **http://127.0.0.1:7010**. The first run has no
restaurant, so it opens the setup wizard: name the restaurant, pick a language
and a theme, create the owner account.

`npm start` runs what `npm run build` produced, so after changing any
TypeScript run `npm run build` again. Changes to the front-ends
(`apps/web/**`), the languages (`locales/*.json`) and the themes
(`themes/*.json`) need no build — reload the page.

### The two ports, and why the phone sees nothing yet

| Port | Who | When |
|---|---|---|
| **7010** | the console, on this computer only (`127.0.0.1`) | always |
| **7020** | tables, kitchen, till, waiter — the restaurant's Wi-Fi | **only once a licence is active** |

Before activation the LAN listener never binds. That is deliberate, and it is
why a phone with the terminal app installed finds nothing to connect to: there
is nothing listening yet. To get a licence for your own testing, run the vendor
side too:

```bash
npm run keygen -- --out secrets/signing-key.json
QSERVE_LS_SIGNING_KEY_FILE=./secrets/signing-key.json npm run start:license-server
```

The vendor console is at **http://localhost:8090/admin** and prints its first
password once. Issue a key there, paste it into the restaurant console's
**Licence** screen, and port 7020 opens immediately with everything you built
still in place.

## Checking your work

```bash
npm run check
```

That is the build, then the validators, then the tests — the same three things
the release workflow runs, so if it passes here it passes there.

The validators are worth knowing by name, because they are what stop a
half-finished change from shipping:

| | |
|---|---|
| `npm run validate:i18n` | every text in every language, and no key used but not translated |
| `npm run validate:themes` | every theme carries every design token |
| `npm run validate:audit` | every audited action and every setting has a sentence a person can read |
| `npm run validate:version` | the version agrees in the three files that ship it |

## Useful switches

Set these in front of `npm start` (Git Bash / macOS / Linux) or with `set` in a
Windows command prompt.

| | |
|---|---|
| `QSERVE_DATA_DIR` | where the restaurant lives. Default `./data/restaurant`; the packaged Windows build uses `%LOCALAPPDATA%\QServe\data`. Point it somewhere else to keep a scratch restaurant beside your real one. |
| `QSERVE_ADMIN_PORT` · `QSERVE_LAN_PORT` | the two ports above, when something else already holds them |
| `QSERVE_DEVELOPER_MODE=true` | adds the **Developer** section: authoring the languages and themes that ship *with the product*, and the vendor's own name, prices and contact details |
| `QSERVE_PUBLIC_HOST` | the host the QR codes are built from, when the machine's own name is not the one the devices can reach |

## Cutting a release

Change the version in the three files `npm run validate:version` checks, write
what changed at the end of `packaging/RELEASE_NOTES.md`, put the new version on
the first line of `packaging/release.txt`, and push. The workflow builds the
Windows folder and the Android APK, tags the commit and publishes both.
[PACKAGING.md](PACKAGING.md) has the details.

## Where things are

```
apps/server/        the restaurant's own server — HTTP, WebSocket, SQLite, the modules
apps/license-server/  the vendor's side: issues and transfers licences, holds no restaurant data
apps/web/           the six front-ends: console, customer, waiter, cashier, kitchen, printer
packages/           shared domain types, crypto, the HTTP layer, the database layer
locales/            every text in the product, one file per language
themes/             the design tokens every screen is drawn from
packaging/          the Windows bundle and the Android terminal
docs/               how it is built, and why
```

[ARCHITECTURE.md](ARCHITECTURE.md) is the map; [EXTENDING.md](EXTENDING.md) is
how to add a module without touching the ones already there.
