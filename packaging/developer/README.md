# developer — the licence server

The half of the product a restaurant never sees. It issues the licence keys
restaurants type in, verifies them, and holds the record of who bought what.

```
npm run build:developer     # -> dist/developer/QServe-Vendor-<version>-windows-x64.exe
```

One file, no window. On first run it **makes its own signing key** and shows you
where — back that file up the same day. Every licence you ever issue is verified
against it, and it cannot be recovered or reissued: lose it and no restaurant
you have already sold to can ever be given a new licence.

It writes two files into `%LOCALAPPDATA%\QServe Vendor\secrets\`:

| file | secret? | what it is for |
|---|---|---|
| `signing-key.json` | **yes** | signs certificates. Never leaves this machine. |
| `trusted-keys.json` | no | the public half. Goes into the restaurant builds you ship — put it in the `QSERVE_TRUSTED_KEYS` repository secret. |

Your first sign-in is written once to `%LOCALAPPDATA%\QServe Vendor\logs\vendor.log`.

Unlike the restaurant server, this one listens on the network rather than on
loopback: restaurants have to reach it to activate. It is the only part of
QServe that needs to be reachable from the internet, and only for activation and
transfer — never during a service.

## And a phone app

```
npm run build:phone     # both flavours; the vendor one is app-developer-release.apk
```

`QServe-Vendor-Terminal-<version>.apk` — the same window onto a QServe server
the restaurant's app is, pointed at your licence server instead. Built from the
same source as [../phone/](../phone/) as a second flavour, with its own package
id so a vendor testing against a restaurant can install both.

It has no QR scanner: your server issues licence keys, it does not print cards.
What it does have is an **app lock** — a code asked for every time it opens.
That app can issue licences, and a phone gets left on a counter. The code is
stored as a salted SHA-256, never in the clear, and the lock screen carries
FLAG_SECURE so it does not leak the console behind it to the task switcher.
