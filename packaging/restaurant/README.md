# restaurant — the server a restaurant runs

The whole product in one file: the server, the management console, the six
front-ends, the language and theme packs, and a native SQLite.

```
npm run build:restaurant     # -> dist/restaurant/QServe-<version>-windows-x64.exe
node packaging/restaurant/build.mjs --no-pack   # stage the payload only
```

Download it, run it. Nothing to unzip, no installer, and no console window — it
opens the management console in a browser and gets out of the way. It unpacks
itself into `%LOCALAPPDATA%\QServe\runtime\<hash>` on first run; the
restaurant's own data lives in `%LOCALAPPDATA%\QServe\data` and is never inside
the program, so replacing the .exe never touches the restaurant.

Build it **on Windows**: `better-sqlite3` is native and the copy baked in has to
be the Windows one. The script says so rather than shipping it quietly.

Without a trust store (`apps/server/config/trusted-keys.json`, from the
developer app) the build still runs but nothing it produces can be activated —
it stays in SETUP forever. The build warns twice.

See [../../docs/PACKAGING.md](../../docs/PACKAGING.md) for how the single file works.
