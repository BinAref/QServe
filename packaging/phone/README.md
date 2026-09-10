# phone — the Android app

A window onto the restaurant's own server, for the restaurant's own devices: a
kitchen tablet, a waiter's phone, a tablet propped on a table.

```
npm run build:phone     # -> packaging/phone/app/build/outputs/apk/release/
```

Needs the Android SDK and JDK 17. It holds no restaurant data at all — no
account, no cached menu, no copy of an order. A lost phone is a lost phone.

Three jobs it does because a web page in a restaurant cannot do them for itself:
reading a station's printed QR code with the camera, handing the page the
clipboard (browsers give no clipboard to a plain-HTTP page, and the restaurant's
own wire will never have a certificate), and staying connected with the screen
off so a kitchen tablet on a shelf does not miss a ticket.

Its language and its light/dark theme follow the device, and either can be
overridden from a dropdown on the setup screen. A device in a language QServe
does not ship gets English.
