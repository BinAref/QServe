QServe is a **local** restaurant operating system. It runs on the restaurant's
own computer, serves the diners' menus and the staff screens over the
restaurant's own Wi-Fi, and needs no internet to run a service.

## What is in this release

| File | What it is |
|---|---|
| `QServe-<version>-windows-x64.exe` | The restaurant server, for the computer that runs the restaurant. One file — download it and run it. |
| `QServe-Terminal-<version>.apk` | The Android app for the restaurant's own devices — a kitchen tablet, a waiter's phone, a tablet on a table. It points at the computer above. |

## Installing

**The computer.** Download the `.exe` and run it. That is the whole install:
nothing to unzip, no folder to keep together, no setup program, and no black
window — it opens the management console in your browser and gets out of the
way. Windows may say the publisher is unknown, because this build is not signed
with a certificate: *More info* → *Run anyway*.

Running it again while it is already running just brings the console back to the
front. To stop QServe, close it from the Windows notification area or end it in
Task Manager; while it runs, the computer will not fall asleep — shut the lid and
the dining room keeps ordering.

Your restaurant's data — menu, orders, licence — lives in
`%LOCALAPPDATA%\QServe\data`, never with the program, so replacing the `.exe`
with a newer one leaves the restaurant untouched. Back it up from the console
under **Backup**. If something ever goes wrong there is a log at
`%LOCALAPPDATA%\QServe\logs\qserve.log`.

**The devices.** Install the APK, open it, tap **Scan a station code** and point
the device at the code the console shows under **Terminals**. Each device
remembers its own station.

## Before you have a licence

Everything you need to *prepare* works immediately, with no payment and no
account: build your real menu, in as many languages as you like, set your
currencies, design your own theme. That work is yours and is kept when you
activate — you never rebuild it.

What a licence turns on is the running of the restaurant: real tables and their
QR codes, staff stations, the kitchen board, the till, printing, reports, and
the server on your own Wi-Fi. The console's **Licence** page says how to ask for
one and what it costs; QServe itself takes no payment.

## What changed in 1.0.2

The management console was rebuilt around one layout rather than several. Every
screen now says one thing at a time:

- **A list is a list.** Languages, themes, roles, stations, currencies, shipped
  packs and licence prices are rows — the thing on one side, what you can do to
  it on the other, and the sentence that explains it underneath. They are held
  to a reading width, so a name and its buttons are no longer a screen apart.
- **Reference is folded away.** The activity log's filters, a pack's rejected
  files, the licence message, the capability list: each is one line you can open
  rather than a wall you have to read past.
- **Settings and the developer screen have tabs**, so you see the section you
  came for.
- **One mark per row.** "Default", "In use" and "Online" are worth a pill;
  everything else is a word in a sentence.
- **A considered type scale.** Six sizes, each a visible step from the last.
- **The setup wizard shows you the theme and language you are picking**, as you
  pick them.

And the things that only turn up when someone reads every line: the kitchen no
longer prints "863 min ago" or a raw `CUSTOMER`, counts read as sentences in
every language, and Delete now sits at the far end of a dialog, away from Save.

## What changed in 1.0.3

**Setting up a device is now: point the camera at the station's code.** The
Android terminal registers itself as the opener for a station link, so scanning
the code the console shows under **Terminals** opens the app already pointed at
the restaurant — nothing to read off one screen and type into another.

The setup screen also says what it never said: this app is a window onto the
computer that runs the restaurant, and that computer has to be running QServe
on the same Wi-Fi **with its licence activated**. Before activation the
restaurant server does not open to the network at all, so no address would have
answered. The address box no longer arrives pre-filled with "http://", which had
been hiding the example.

## What changed in 1.0.4

**The Windows download is one file.** `QServe-1.0.4-windows-x64.exe` — no zip,
no folder, no installer. Download it and run it. The whole product is inside the
executable and unpacks itself the first time it starts.

**And it opens no window.** Previous builds were a copy of the Node runtime,
which Windows treats as a console program and gives a black terminal to whether
or not anything is written in it. It now runs like any other application. What
it used to print goes to `%LOCALAPPDATA%\QServe\logs\qserve.log`, and anything
that stops it starting is shown in a dialog rather than in a window that closes
before it can be read.

**A build that could not start has been fixed.** The 1.0.3 bundle was assembled
in an order that let `npm install` delete the workspace packages it had just been
given, so `QServe.exe` opened, reported that `@qserve/shared` was missing, and
closed. The build now stages them where npm cannot prune them, and refuses to
produce an executable at all if any of them is absent.

**The restaurant stays open while the computer sleeps.** QServe holds a power
request for as long as it is running, so a laptop with its lid shut goes into
away mode instead of sleep — screen dark, fans quiet, tables still ordering.
Locking the screen never stopped it and still does not.

**Paste and clear, in every box in the product.** A clear button appears in a
field the moment there is something in it and goes when there is not, so on a
phone emptying a box is a tap rather than a long press and a drag. Paste is
offered wherever pasting can actually work — which on a staff device means
inside the QServe Android app, because a page served over the restaurant's own
Wi-Fi is not allowed a clipboard by any browser.

**The restaurant's own mark is the app icon.** Console → Settings → **Brand**
takes a PNG, JPEG or SVG and uses it as the icon on every screen QServe runs:
the browser tab, the task switcher, and the home screen when a waiter adds a
station to a phone. Adding a station to a home screen now also names it after
the restaurant rather than after the software.

**A menu data-entry role.** Building a real menu is days of work and is rarely
the owner who does it. Handing that job to somebody used to mean handing them a
manager's account, which also opens the till, the reports and the takings. The
new built-in role opens the menu and the dish photography, and nothing else.
Existing installations gain it on their next start.

**The Android app reads station codes itself.** Tap **Scan a station code** and
point the device at the card. It no longer depends on the phone's own camera app
offering to open the link, which some phones do only after a settings change and
a tablet with no camera app cannot do at all. Nothing is stored or uploaded, and
the camera is asked for at the moment it is used.

**And it keeps working with its screen off.** A kitchen tablet on a shelf or a
phone in an apron pocket used to be suspended by Android between orders. The app
now runs as a station service with a notification you can stop it from, holding
the CPU and the Wi-Fi radio awake for as long as it is pointed at a restaurant.

## What changed in 1.0.5

**The Android setup screen was rebuilt.** It was a wall of explanation above two
identical grey buttons — the platform's defaults, in a product that has its own
themes. It now uses the same palette the restaurant's own screens are drawn in,
and it is ordered by what a person standing in a kitchen with a printed card is
about to do: scan, or failing that type, with the conditions as a note at the
bottom rather than two paragraphs at the top.

**Paste and clear, in the address box.** The same pair the product puts in every
field on every screen, for the same reason: an address arrives by message and is
pasted, and clearing a box by hand on a phone is a long press and a drag. Clear
appears only when there is something to clear.

**The app's language is picked in the app.** Arabic, English and Turkish, on the
setup screen. A restaurant's second-hand tablets arrive in whatever language the
last owner left them in, and a waiter's own phone is in the waiter's — neither
is a decision the restaurant made, and neither should send somebody into Android
settings before a station can be set up. The choice is remembered per device and
reaches the screens, the scanner and the station notification. Unchosen, the
phone's own language still wins.

## What changed in 1.0.6

**The Android app has a light theme and a dark one, and follows the device.**
Both palettes are the product's own — `themes/light.json` and `themes/dark.json`,
the same ones the restaurant's screens are drawn in. A tablet set to dark gets a
dark setup screen with no setting to find, and a device set to light gets a light
one. It can also be told: **Theme → System, Light, Dark.**

**The language follows the device too**, and can be told the same way:
**Language → System, العربية, English, Türkçe.** A device set to a language
QServe does not ship — French, Korean, anything — gets English, because that is
what the app's default strings are. Both controls are plain dropdowns listing
names. No flags: a flag is a country, and Arabic is not a country.

Both choices are applied where an app's resources are attached, so they reach
every screen, every button, the scanner, the toasts and the station notification
— not just the screen the choice was made on.

## What changed in 1.0.7

**Every screen opens in the language of the device reading it.** A diner scans a
table code on a phone set to Turkish and gets the menu in Turkish; the waiter
beside them, on an Arabic phone, gets Arabic — from the same restaurant, at the
same table, with nothing to set on either device.

It only ever picks among the languages the restaurant has switched on, so this
widens nothing: a restaurant offering Arabic and English offers exactly that,
and a device asking for anything else gets the restaurant's own default. A
language chosen by hand on a device still wins over all of it.

This also fixes something that was quietly wrong: `/api/i18n/locales` answers
with every language pack installed, each carrying whether it is enabled — the
console needs the full list to draw its switches. The terminals were reading
that list as though it were the restaurant's offer, so a restaurant that had
switched a language off could still be shown it.

## What changed in 1.0.8

**Three things ship now, not two, and each has its own folder.**

| | |
|---|---|
| `QServe-Vendor-<version>-windows-x64.exe` | **new.** The licence server, for whoever sells QServe. A restaurant never runs it. |
| `QServe-<version>-windows-x64.exe` | The restaurant's own server, as before. |
| `QServe-Terminal-<version>.apk` | The Android app, as before. |

The licence server had no packaged form at all: running it meant cloning the
repository and knowing which npm script to type, which is a strange thing to ask
of the person whose whole job is selling the software. It is now one file that
opens no window, like the other one — and on first run it **makes its own
signing key**, then says so in a dialog nobody can miss. That key is the thing
every licence you ever issue is verified against; it cannot be recovered or
reissued, so back it up the day you make it. The public half lands beside it,
ready to go into the restaurant builds you ship.

**Every screen opens in the language of the device reading it** — carried over
from 1.0.7 and now confirmed against the cases that matter. A restaurant
offering Arabic and English, with Arabic as its own default:

  a phone in Arabic   ->  Arabic     the device's own language, offered
  a phone in English  ->  English    the device's own language, offered
  a phone in Korean   ->  Arabic     not offered, so the restaurant's default

It never widens what the restaurant offers: a device asking for a language that
has been switched off gets the restaurant's default, and a language chosen by
hand on a device still wins over all of it.
