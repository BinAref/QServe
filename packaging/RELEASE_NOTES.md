QServe is a **local** restaurant operating system. It runs on the restaurant's
own computer, serves the diners' menus and the staff screens over the
restaurant's own Wi-Fi, and needs no internet to run a service.

## What is in this release

| File | What it is |
|---|---|
| `QServe-<version>-windows-x64.zip` | The restaurant server, for the computer that runs the restaurant. Unzip it and run `QServe.exe`. |
| `QServe-Terminal-<version>.apk` | The Android app for the restaurant's own devices — a kitchen tablet, a waiter's phone, a tablet on a table. It points at the computer above. |

## Installing

**The computer.** Unzip the folder anywhere and run `QServe.exe`. The management
console opens in your browser. Windows may say the publisher is unknown, because
this build is not signed with a certificate: *More info* → *Run anyway*.

Your restaurant's data — menu, orders, licence — lives in
`%LOCALAPPDATA%\QServe\data`, never inside the program folder, so replacing that
folder with a newer version leaves the restaurant untouched. Back it up from the
console under **Backup**.

**The devices.** Install the APK, open it once, and paste the address the
console shows under **Terminals**. Each device remembers its own station.

## Before you have a licence

Everything you need to *prepare* works immediately, with no payment and no
account: build your real menu, in as many languages as you like, set your
currencies, design your own theme. That work is yours and is kept when you
activate — you never rebuild it.

What a licence turns on is the running of the restaurant: real tables and their
QR codes, staff stations, the kitchen board, the till, printing, reports, and
the server on your own Wi-Fi. The console's **Licence** page says how to ask for
one and what it costs; QServe itself takes no payment.
