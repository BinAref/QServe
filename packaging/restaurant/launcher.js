/*
 * QServe.exe — the thing an owner double-clicks.
 *
 * One file. Not a folder, not an installer, not a window: the entire product —
 * the server, the six front-ends, the language packs, the themes, even the
 * native SQLite — is packed into a ZIP that is baked into this executable, and
 * this script unpacks it on first run and starts the server from it.
 *
 * Three properties are deliberate, and each one is a thing an owner noticed:
 *
 *   No console window. The executable is marked as a GUI program by the build,
 *   so Windows opens nothing. Everything this file would have printed goes to
 *   a log instead, and anything fatal is shown in a dialog, because a message
 *   in a window that closes in half a second is not a message.
 *
 *   Nothing to unzip. A download is an .exe and running it is the install.
 *
 *   It keeps trading while the machine is locked or asleep. A restaurant does
 *   not stop taking orders because somebody shut the laptop lid.
 *
 * It is CommonJS because that is what a SEA main script is loaded as; the
 * server itself is ordinary ES modules, imported from the unpacked folder.
 */

'use strict';

const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync, writeSync,
} = require('node:fs');
const net = require('node:net');
const { dirname, join, resolve } = require('node:path');
const { format } = require('node:util');
const { inflateRawSync } = require('node:zlib');
const { pathToFileURL } = require('node:url');

/* --------------------------------------------------------------- where things live */

/**
 * The restaurant's data — its menu, its orders, its licence — never lives with
 * the program. Replacing QServe.exe with a newer one must never be able to take
 * the restaurant with it.
 */
const localAppData = process.env.LOCALAPPDATA || join(dirname(process.execPath), 'QServe-data');
const home = join(localAppData, 'QServe');
const dataDir = process.env.QSERVE_DATA_DIR || join(home, 'data');
const logDir = join(home, 'logs');
const runtimeRoot = join(home, 'runtime');

mkdirSync(logDir, { recursive: true });

/* ------------------------------------------------------------------------ the log */

/*
 * A GUI program has no stdout. Node still hands out a `process.stdout`, and
 * writing to it either vanishes or raises EBADF depending on how the program
 * was launched — neither of which is a way to run a till. So every line the
 * product prints is captured here, synchronously, so that a crash leaves its
 * last words on disk rather than in a buffer nobody flushed.
 */
const logFile = join(logDir, 'qserve.log');
try {
  if (existsSync(logFile) && statSync(logFile).size > 5 * 1024 * 1024) {
    renameSync(logFile, join(logDir, 'qserve.previous.log'));
  }
} catch { /* a log we cannot rotate is not a reason to refuse to trade */ }

let logFd = null;
try { logFd = openSync(logFile, 'a'); } catch { logFd = null; }

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
function record(line) {
  if (logFd === null) return;
  try { writeSync(logFd, `${stamp()}  ${line}\n`); } catch { /* disk full, still trade */ }
}

const toLine = (args) => format(...args);
console.log = (...args) => record(toLine(args));
console.info = console.log;
console.debug = console.log;
console.warn = (...args) => record(`WARN  ${toLine(args)}`);
console.error = (...args) => record(`ERROR ${toLine(args)}`);
// Anything that writes to the streams directly — a dependency, Node itself —
// lands in the same place instead of failing against a handle that is not there.
for (const stream of ['stdout', 'stderr']) {
  try {
    process[stream].write = (chunk) => {
      record(String(chunk).replace(/\r?\n$/, ''));
      return true;
    };
  } catch { /* the stream is not writable; the console override still holds */ }
}

/* --------------------------------------------------------------------- telling off */

/**
 * Something went wrong and there is no window to say so in.
 *
 * The dialog carries the one sentence that helps and the path to the log, and
 * the text goes through a file rather than the command line so that a Windows
 * path with a quote in it cannot rewrite the command.
 */
function fatal(title, detail) {
  record(`FATAL ${title}: ${detail}`);
  const messageFile = join(logDir, 'last-error.txt');
  const body = `${title}\n\n${detail}\n\nFull log:\n${logFile}`;
  try { writeFileSync(messageFile, body, 'utf8'); } catch { return; }
  try {
    spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms;'
      + `[System.Windows.Forms.MessageBox]::Show([IO.File]::ReadAllText(${quote(messageFile)}),`
      + " 'QServe', 'OK', 'Error') | Out-Null",
    ], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* no dialog is possible; the log is still written */ }
}

/** A PowerShell single-quoted literal: the only escape inside one is a doubled quote. */
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

process.on('uncaughtException', (error) => {
  fatal('QServe stopped unexpectedly.', error?.stack ?? String(error));
  process.exitCode = 1;
});
process.on('unhandledRejection', (reason) => {
  record(`UNHANDLED ${reason?.stack ?? String(reason)}`);
});

/* ---------------------------------------------------------------------- unpacking */

/**
 * Read a ZIP built by `packaging/windows/zip.mjs`.
 *
 * The central directory at the end of the file is the index; the entries are
 * walked from there rather than by scanning forwards, which is what the format
 * intends and what makes it safe to append the archive to an executable.
 *
 * Entry names are checked rather than trusted. An archive is data, and data
 * that names `..\\..\\Windows\\System32` must not be able to write there —
 * this one is our own, but code that unpacks archives should never be the code
 * that assumes they are friendly.
 */
function unzip(buffer, destination) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('the application archive is damaged (no directory)');

  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('the application archive is damaged (bad entry)');
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    const target = resolve(destination, name);
    if (target !== destination && !target.startsWith(destination + require('node:path').sep)) {
      throw new Error(`the application archive names a file outside itself: ${name}`);
    }

    // The local header repeats the name and extra field, and its extra field
    // is allowed to differ in length from the central one — so read the sizes
    // from the local header rather than assuming they match.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, method === 8 ? inflateRawSync(raw) : raw);
  }
}

/**
 * Unpack the application, unless this exact build is already unpacked.
 *
 * The folder is named after a hash of the payload, so a new version unpacks
 * beside the old one rather than over it — an upgrade cannot half-replace a
 * running install — and the marker is written last, so an unpack interrupted
 * by a power cut is repeated rather than trusted.
 */
function unpack(payload) {
  const digest = createHash('sha256').update(payload).digest('hex').slice(0, 16);
  const target = join(runtimeRoot, digest);
  const marker = join(target, '.unpacked');

  if (existsSync(marker)) return target;

  record(`unpacking ${payload.length} bytes into ${target}`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  unzip(payload, target);
  writeFileSync(marker, `${digest}\n`);

  // Previous versions, once this one is known good. Kept until now so that a
  // failed unpack still leaves a working install on the machine.
  try {
    for (const entry of readdirSync(runtimeRoot)) {
      if (entry !== digest) rmSync(join(runtimeRoot, entry), { recursive: true, force: true });
    }
  } catch { /* an old copy left behind wastes disk, nothing more */ }

  return target;
}

/* ------------------------------------------------------------- staying awake */

/**
 * Keep trading while the machine is locked, or asleep with the lid shut.
 *
 * Locking a Windows session does not stop a program, so that half is free. Sleep
 * does stop it, and a restaurant whose till went to sleep at 3pm is a restaurant
 * whose table QR codes stopped working at 3pm. Windows has one answer for this —
 * `SetThreadExecutionState` — and asking for it needs a Win32 call, which this
 * process cannot make on its own without a native module.
 *
 * So it is asked for by a small hidden PowerShell that holds the request open
 * and watches this process: when QServe stops, the request is dropped and the
 * machine sleeps normally again. ES_AWAYMODE_REQUIRED is the important flag —
 * it puts the computer into away mode instead of sleep, so the screen goes dark
 * and the fans stop, but the server keeps answering the dining room.
 */
function stayAwake() {
  const script = [
    '$ErrorActionPreference = "SilentlyContinue";',
    'Add-Type -Name Power -Namespace QServe -MemberDefinition',
    "'[DllImport(\"kernel32.dll\", SetLastError=true)]",
    "public static extern uint SetThreadExecutionState(uint flags);';",
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED
    '[QServe.Power]::SetThreadExecutionState(0x80000000 -bor 0x1 -bor 0x40) | Out-Null;',
    `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 };`,
    // Hand the machine back before going: ES_CONTINUOUS on its own clears it.
    '[QServe.Power]::SetThreadExecutionState(0x80000000) | Out-Null;',
  ].join(' ');

  try {
    const keeper = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script,
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    keeper.unref();
    record('power request held: the computer will not sleep while QServe is running');
  } catch (error) {
    // Worth a line in the log and nothing more. The restaurant still trades;
    // it just sleeps when Windows decides to.
    record(`could not hold a power request: ${error?.message ?? error}`);
  }
}

/* ------------------------------------------------------------------- the browser */

/** Open the console in whatever the owner uses as a browser, with no window of our own. */
function openBrowser(url) {
  try {
    spawn(process.env.COMSPEC || 'cmd', ['/c', 'start', '""', url], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
  } catch (error) {
    record(`could not open a browser: ${error?.message ?? error}`);
  }
}

/** Is a QServe already answering on this port? Double-clicking twice is not an error. */
function alreadyRunning(port) {
  return new Promise((done) => {
    const probe = net.connect({ host: '127.0.0.1', port }, () => {
      probe.destroy();
      done(true);
    });
    probe.on('error', () => done(false));
    probe.setTimeout(700, () => { probe.destroy(); done(false); });
  });
}

/* ------------------------------------------------------------------------- start */

async function main() {
  const port = Number(process.env.QSERVE_ADMIN_PORT ?? 7010);
  const consoleUrl = `http://127.0.0.1:${port}/console/`;

  // A second double-click brings the console forward rather than starting a
  // second server that would fail to bind and look, from outside, like nothing
  // happening at all.
  if (await alreadyRunning(port)) {
    record('QServe is already running; bringing the console forward');
    openBrowser(consoleUrl);
    return;
  }

  /*
   * Where the application is. Inside the executable in a real build; beside it
   * in the folder layout, which is what a developer gets from `--no-pack` and
   * what keeps this file runnable without a 100 MB build to test a one-line
   * change.
   */
  let appRoot;
  let sea = null;
  try { sea = require('node:sea'); } catch { sea = null; }

  if (sea?.isSea?.()) {
    const asset = sea.getAsset('payload.zip');
    appRoot = unpack(Buffer.from(asset));
  } else {
    appRoot = dirname(process.execPath);
    record(`not a packed build; running from ${appRoot}`);
  }

  const entry = join(appRoot, 'app', 'server', 'dist', 'main.js');
  if (!existsSync(entry)) {
    fatal(
      'QServe could not find its application files.',
      `Expected them at:\n${entry}\n\n`
      + 'If this is a downloaded QServe.exe, download it again — the copy on '
      + 'this machine is incomplete.',
    );
    process.exitCode = 1;
    return;
  }

  /*
   * Every path the server resolves is stated here rather than left to its own
   * defaults. The defaults assume the repository layout; this is an unpacked
   * runtime in a folder named after a hash, and guessing would be the kind of
   * bug that only appears on somebody else's computer.
   */
  const env = process.env;
  env.QSERVE_DATA_DIR = dataDir;
  env.QSERVE_WEB_ROOT ??= join(appRoot, 'app', 'web');
  env.QSERVE_LOCALES_DIR ??= join(appRoot, 'locales');
  env.QSERVE_THEMES_DIR ??= join(appRoot, 'themes');
  env.QSERVE_TRUSTED_KEYS_FILE ??= join(appRoot, 'app', 'server', 'config', 'trusted-keys.json');
  env.QSERVE_VENDOR_INFO_FILE ??= join(appRoot, 'app', 'server', 'config', 'vendor.json');

  /*
   * And where to ask for a licence, baked in at build time.
   *
   * `??=` on purpose: an operator who sets the variable — to point at a staging
   * licence server, or at a replacement after the vendor moves — keeps winning
   * over what was shipped.
   */
  if (!env.QSERVE_LICENSE_SERVER_URL) {
    const where = join(appRoot, 'app', 'server', 'config', 'license-server.json');
    try {
      const { url } = JSON.parse(readFileSync(where, 'utf8'));
      if (typeof url === 'string' && url) env.QSERVE_LICENSE_SERVER_URL = url;
    } catch {
      // A build made without the address. The licence screen will say it cannot
      // reach the vendor, which is true and is the best it can do.
    }
  }

  mkdirSync(dataDir, { recursive: true });
  record(`QServe starting — data ${dataDir}, runtime ${appRoot}`);

  let started;
  try {
    const server = await import(pathToFileURL(entry).href);
    started = await server.start();
  } catch (error) {
    fatal(
      'QServe could not start.',
      `${error?.message ?? error}\n\n`
      + 'This is usually a port already in use, or a data folder QServe is not '
      + 'allowed to write to.',
    );
    process.exitCode = 1;
    return;
  }

  record(`console listening on ${consoleUrl}`);
  stayAwake();
  openBrowser(consoleUrl);

  const shutdown = () => {
    record('shutting down');
    started.stop().catch((error) => record(`shutdown failed: ${error?.stack ?? error}`))
      .finally(() => {
        if (logFd !== null) { try { closeSync(logFd); } catch { /* closing */ } }
        process.exit(0);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  fatal('QServe could not start.', error?.stack ?? String(error));
  process.exitCode = 1;
});
