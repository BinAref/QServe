# Packaging and releases

Two things a restaurant installs, and neither is the repository:

| Artifact | Who runs it | What it is |
|---|---|---|
| `QServe-<version>-windows-x64.zip` | the restaurant's computer | the whole product: server, console, six front-ends, language and theme packs |
| `QServe-Terminal-<version>.apk` | the restaurant's own phones and tablets | a window onto that computer |

Neither can be built honestly on one machine: the Windows bundle carries a
native SQLite that must be compiled on Windows, and the Android package needs
the Android SDK. `.github/workflows/release.yml` builds each on a runner that
has what it needs, so cutting a release is a commit:

```
echo v1.0.1 > packaging/release.txt   # then commit and push it
```

Pushing that file is the trigger. The workflow builds both artifacts, tags the
commit, and publishes a release carrying them — no tag push and no token with
special powers, and the reason for the release sits in the commit message beside
it. Only the first line of the file is read.

The same workflow can be run by hand from the Actions tab; given a tag it
publishes, and without one it builds both artifacts and attaches them to the run.

---

## The Windows bundle

```
node packaging/windows/build.mjs
```

Produces `dist/QServe-<version>-windows-x64.zip`. Run it on Windows: it is the
step that compiles `better-sqlite3`, and a bundle built anywhere else carries
the wrong native binary. The script says so rather than shipping it quietly.

What comes out is a folder, not an installer:

```
QServe.exe        the Node runtime with the launcher baked in (Node SEA)
app/server/dist   the server
app/server/config the vendor's public keys — only ever the public half
app/web           the six front-ends
app/node_modules  three runtime dependencies, plus the workspace packages
locales/ themes/  the packs the product ships with
README.txt
```

`QServe.exe` is a copy of `node.exe` with `packaging/windows/launcher.js`
injected into it. The launcher sets the data directory to
`%LOCALAPPDATA%\QServe\data`, imports `app/server/dist/main.js`, calls `start()`
and opens the console. The server therefore runs **inside** that one executable:
there is no second runtime beside it and nothing to install.

The layout mirrors the repository deliberately, so the server's own defaults
find the web root (`app/web`), the packs (`../locales`, `../themes`) and the
trust store (`app/server/config/trusted-keys.json`) without the launcher having
to tell it where anything is. Only the data directory is overridden — because a
restaurant's data must survive replacing the program folder.

### The trust store

`apps/server/config/trusted-keys.json` holds the **public** keys an installation
verifies activation certificates against, offline. It is not in the repository
(each vendor generates their own with `npm run keygen`), so the release workflow
writes it from the `QSERVE_TRUSTED_KEYS` repository secret. Without it the build
still succeeds and still runs — but nothing it produces can be activated, and
the build says so.

The signing key itself never leaves the vendor's machine and is never packaged.
See [SECURITY.md](SECURITY.md).

---

## The Android terminal

```
cd packaging/android && gradle assembleRelease
```

A deliberately small app: one activity, one WebView, one remembered address, no
third-party dependencies. It exists so a station is something a member of staff
taps on a home screen rather than a URL they keep in a browser, and so a kitchen
screen stays awake and stays on the board.

It holds no restaurant data at all — no account, no cached menu, no copy of an
order. A lost phone is a lost phone.

Release builds are signed with the debug key unless a keystore is supplied, so a
clean checkout still produces an installable APK. To sign a real one, set
`storeFile`, `storePassword`, `keyAlias` and `keyPassword` in a release signing
config before publishing to a store; a restaurant installing the APK directly
does not need it.
