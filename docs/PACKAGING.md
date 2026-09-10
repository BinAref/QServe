# Packaging and releases

Three things ship, and none of them is the repository. Each has its own folder
under `packaging/`, its own build script, and its own README:

| Folder | Artifact | Who runs it |
|---|---|---|
| [`developer/`](../packaging/developer/) | `QServe-Vendor-<version>-windows-x64.exe` | **you**, the vendor. The licence server that issues keys. A restaurant never runs this. |
| [`restaurant/`](../packaging/restaurant/) | `QServe-<version>-windows-x64.exe` | the restaurant's computer. Server, console, six front-ends, packs — one file. |
| [`phone/`](../packaging/phone/) | `QServe-Terminal-<version>.apk` | the restaurant's own phones and tablets. A window onto that computer. |

```
npm run build:developer      # -> dist/developer/
npm run build:restaurant     # -> dist/restaurant/
npm run build:phone          # -> packaging/phone/app/build/outputs/apk/release/
npm run build:all
```

The two Windows executables share everything from "stage a folder" onwards —
fetch a Node runtime, zip the payload, bake both into it, stop Windows opening a
console — so that half lives once in [`packaging/lib/windows-exe.mjs`](../packaging/lib/windows-exe.mjs)
and each build script only stages its own payload.

None of them can be built honestly on one machine: both Windows executables
carry a native SQLite that must be compiled on Windows, and the Android package
needs the Android SDK. `.github/workflows/release.yml` builds each on a runner
that has what it needs, so cutting a release is a commit:

```
echo v1.0.1 > packaging/release.txt   # then commit and push it
```

Pushing that file is the trigger. The workflow builds all three, tags the
commit, and publishes a release carrying them — no tag push and no token with
special powers, and the reason for the release sits in the commit message beside
it. Only the first line of the file is read.

The same workflow can be run by hand from the Actions tab; given a tag it
publishes, and without one it builds all three and attaches them to the run.

---

## The restaurant's executable

```
node packaging/restaurant/build.mjs            # one .exe in dist/
node packaging/restaurant/build.mjs --no-pack  # stage the payload only, for checking the layout
```

Produces `dist/restaurant/QServe-<version>-windows-x64.exe` — one file, ~90 MB.
There is nothing to unzip, no folder to keep together and no installer. Run the
build on Windows: it is the step that compiles `better-sqlite3`, and an
executable built anywhere else carries the wrong native binary. The script says
so rather than shipping it quietly.

### How the one file works

The build stages the product into a folder, ZIPs it, and bakes the ZIP into a
copy of the Node runtime as a [SEA](https://nodejs.org/api/single-executable-applications.html)
asset alongside `packaging/restaurant/launcher.js`:

```
app/server/dist    the server
app/server/config  the vendor's public keys — only ever the public half
app/web            the six front-ends
app/node_modules   three runtime dependencies, plus the workspace packages
locales/ themes/   the packs the product ships with
```

On first run the launcher unpacks that into
`%LOCALAPPDATA%\QServe\runtime\<hash of the payload>`, then imports
`app/server/dist/main.js` from it and calls `start()`. The folder is named after
the payload, so a new version unpacks *beside* the old one rather than over it —
an upgrade cannot half-replace a running install — and the marker file that says
"this one is complete" is written last, so an unpack cut short by a power failure
is repeated rather than trusted. Older runtimes are removed once the new one is
known good.

Every path the server would otherwise resolve for itself is stated by the
launcher — web root, packs, trust store, vendor details, data directory —
because the defaults assume the repository layout and this is a folder named
after a hash. The data directory is `%LOCALAPPDATA%\QServe\data` and is never
inside the runtime, so replacing the executable never touches the restaurant.

### Two things the build does that are easy to get wrong

**The workspace packages are copied in *after* `npm install`.** npm reifies
`node_modules` to match `package.json` and deletes anything extraneous, and
`@qserve/*` is deliberately not in that list — those are copied, not fetched. A
build that stages them first stages them into the bin, and the executable dies on
launch with `Cannot find package '@qserve/shared'`. The order in `build.mjs` is
load-bearing, and `checking the payload` fails the build rather than shipping it.

**The executable is re-marked as a GUI program.** A copy of `node.exe` is a
console program, and Windows opens a black window for one of those before a line
of our code runs — there is no flag or API that prevents it from the inside. The
build rewrites one 16-bit field in the PE header, subsystem 3 (console) to 2
(GUI). A till is not a terminal.

Because there is then no console, everything the product prints goes to
`%LOCALAPPDATA%\QServe\logs\qserve.log` and anything fatal is shown in a dialog.
A second double-click brings the console forward instead of starting a second
server. And while QServe is running it holds a Windows power request
(`ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED`) so a laptop with
its lid shut goes into away mode rather than sleep: the screen goes dark, the
dining room keeps ordering.

### The trust store

`apps/server/config/trusted-keys.json` holds the **public** keys an installation
verifies activation certificates against, offline. It is not in the repository
(each vendor generates their own with `npm run keygen`), so the release workflow
writes it from the `QSERVE_TRUSTED_KEYS` repository secret. Without it the build
still succeeds and still runs — but nothing it produces can be activated. The
build says so twice while it packs, because "why will my licence key not work"
is a terrible thing for a restaurant to have to discover on a Friday night.

So before cutting a release anyone is meant to pay for: `npm run keygen`, then
put the public half in the `QSERVE_TRUSTED_KEYS` repository secret.

### The vendor's own details

`apps/server/config/vendor.json` holds the name, prices and contact channels a
restaurant sees on its licence screen — the answer to "who do I ask, and what
does it cost". It ships inside the build because a restaurant that has just
unzipped QServe has never been online and cannot fetch anything; whatever it
later fetches from the licence server replaces it.

Nothing in it is secret and nothing in it is trusted: it is text shown to a
person. Prepare it in the console's **Developer** section, which writes the
file, or set the `QSERVE_VENDOR_INFO` repository secret for the release
workflow. Without it the licence screen says "ask us" and names nobody, and the
build says so while it packs.

The signing key itself never leaves the vendor's machine and is never packaged.
See [SECURITY.md](SECURITY.md).

---

## The vendor's executable

```
node packaging/developer/build.mjs
```

Produces `dist/developer/QServe-Vendor-<version>-windows-x64.exe`. Same
technique as the restaurant's and for the same reason — one file, no window —
but this one is yours rather than a customer's, and it had no packaged form at
all until recently. Running the licence server meant cloning the repository and
knowing which npm script to type, which is a strange thing to ask of the person
whose whole job is selling the software.

Two things it does that the restaurant build does not:

**It makes its own signing key on first run**, into
`%LOCALAPPDATA%\QServe Vendor\secrets\`, and then says so in a dialog nobody can
miss. From a checkout that is `npm run keygen`, which is the right shape for
somebody who already has a terminal open; a vendor who downloaded one .exe has
not, and a licence server with no key looks like it works right up until the
first sale. The public half lands beside it, ready for the `QSERVE_TRUSTED_KEYS`
repository secret.

**It listens on the network.** The restaurant server binds its console to
loopback and only opens to the LAN once a licence is active; this one has to
answer restaurants activating, so it binds where it is told. It is the only part
of QServe that needs to be reachable from the internet, and only for activation
and transfer — never during a service.

The keygen tool is deliberately staged into this payload and deliberately kept
out of the restaurant's: a restaurant should never be shipped code that mints
its own activation certificates.

---

## The vendor's executable

\
▸ preparing

▸ installing runtime dependencies
  $ npm install --omit=dev --no-audit --no-fund

added 38 packages in 1m

▸ staging the workspace packages

▸ staging the licence server

▸ checking the payload
  8 required paths present

▸ packing the payload
  420 files, 1.5 MB compressed (66 compiler leftovers dropped)

▸ fetching node 24.18.0 for windows-x64
  $ powershell -NoProfile -Command Expand-Archive -Path 'D:QServeQServepackagingdeveloperuild
ode-v24.18.0-win-x64.zip' -DestinationPath 'D:QServeQServepackagingdeveloperuild' -Force

▸ building QServe-Vendor-1.0.7-windows-x64.exe
  $ C:Program Files
odejs
ode.exe --experimental-sea-config D:QServeQServepackagingdeveloperuildsea-config.json
  $ npx --yes postject D:QServeQServedistdeveloperQServe-Vendor-1.0.7-windows-x64.exe NODE_SEA_BLOB D:QServeQServepackagingdeveloperuildsea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
[36mStart injection of NODE_SEA_BLOB in D:QServeQServedistdeveloperQServe-Vendor-1.0.7-windows-x64.exe...[0m
[32m💉 Injection done![0m

▸ removing the console window
  console subsystem 3 → GUI subsystem 2

▸ done: QServe-Vendor-1.0.7-windows-x64.exe (90 MB)

  This one is yours, not a restaurant's. It makes its own signing key on
  first run and tells you where — back that file up the same day.
Produces . Same technique
as the restaurant's and for the same reason — one file, no window — but this one
is yours rather than a customer's, and it had no packaged form at all until
recently. Running the licence server meant cloning the repository and knowing
which npm script to type, which is a strange thing to ask of the person whose
whole job is selling the software.

Two things it does that the restaurant build does not:

**It makes its own signing key on first run**, into
, and then says so in a dialog nobody can
miss. From a checkout that is , which is the right shape for
somebody who already has a terminal open; a vendor who downloaded one .exe has
not, and a licence server with no key looks like it works right up until the
first sale. The public half lands beside it, ready for the
 repository secret.

**It listens on the network.** The restaurant server binds its console to
loopback and only opens to the LAN once a licence is active; this one has to
answer restaurants activating, so it binds where it is told. It is the only part
of QServe that needs to be reachable from the internet.

The keygen tool is deliberately staged into this payload and deliberately kept
out of the restaurant's: a restaurant should never be shipped code that mints
its own activation certificates.

---

## The Android terminal

```
cd packaging/phone && gradle assembleRelease
```

A small app: one WebView on the restaurant's own server, one remembered address.
It exists so a station is something a member of staff taps on a home screen
rather than a URL they keep in a browser, and so a kitchen screen stays awake and
stays on the board.

It holds no restaurant data at all — no account, no cached menu, no copy of an
order. A lost phone is a lost phone.

Three jobs are done in the app because a web page in a restaurant cannot do them
for itself:

- **Reading a station's printed code.** CameraX for the preview, ZXing for the
  decoding, both bundled — no Play Services, no network at scan time. The camera
  permission is asked for at the moment it is used, and refusing it leaves the
  address box working. `ScannerActivity` keeps only the luminance plane of each
  frame and drops it; nothing is stored and nothing is uploaded.
- **Handing the page the clipboard.** Every box in QServe has a paste button, and
  the browser Clipboard API is unavailable to these pages by design: they are
  served over plain HTTP on the restaurant's own wire, which is not a secure
  context and cannot be one in a building with no certificate authority. The
  `QServeNative.clipboardText()` bridge answers only for the restaurant's own
  host, checked again on every call.
- **Staying connected with the screen off.** `TerminalService` is a foreground
  service holding a partial wake lock and a high-performance Wi-Fi lock, so a
  kitchen tablet on a shelf keeps receiving tickets. Its type is `specialUse`
  rather than `dataSync` on purpose: from Android 14 a `dataSync` service is
  capped at six hours a day, which is shorter than a lunch and a dinner service.
  The notification carries a Stop button.

The four libraries this adds (`androidx.activity`, three `androidx.camera`
modules, `com.google.zxing:core`) all resolve at build time and ship inside the
APK, which is about 3.5 MB. None of them reaches the network at run time.

Release builds are signed with the debug key unless a keystore is supplied, so a
clean checkout still produces an installable APK. To sign a real one, set
`storeFile`, `storePassword`, `keyAlias` and `keyPassword` in a release signing
config before publishing to a store; a restaurant installing the APK directly
does not need it.
