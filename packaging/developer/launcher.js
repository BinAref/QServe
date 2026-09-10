/*
 * QServe Vendor.exe — the licence server, for the person who sells QServe.
 *
 * This is not a thing a restaurant ever runs. It is the other half of the
 * commercial arrangement: it issues the licence keys restaurants type in,
 * verifies them, and holds the record of who bought what. It runs on the
 * vendor's own machine or their own server, and it is the only part of the
 * product that needs to be reachable from the internet.
 *
 * Same shape as the restaurant's executable and for the same reasons — one
 * file, no console window, everything unpacked on first run — with two
 * deliberate differences:
 *
 *   It listens on the network. The restaurant server binds its console to
 *   loopback; this one has to answer restaurants activating a licence, so it
 *   binds where it is told to.
 *
 *   It makes its own signing key on first run, and then says so in a dialog
 *   nobody can miss. From a checkout that is `npm run keygen`, which is the
 *   right shape for somebody who already has a terminal open — a vendor who
 *   downloaded one .exe has not, and a licence server with no key looks like it
 *   works right up until the first sale.
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

const localAppData = process.env.LOCALAPPDATA || join(dirname(process.execPath), 'QServe-vendor');
const home = join(localAppData, 'QServe Vendor');
const dataDir = process.env.QSERVE_LS_DATA_DIR || join(home, 'data');
const secretsDir = join(home, 'secrets');
const logDir = join(home, 'logs');
const runtimeRoot = join(home, 'runtime');

mkdirSync(logDir, { recursive: true });
mkdirSync(secretsDir, { recursive: true });

/* ------------------------------------------------------------------------ the log */

const logFile = join(logDir, 'vendor.log');
try {
  if (existsSync(logFile) && statSync(logFile).size > 5 * 1024 * 1024) {
    renameSync(logFile, join(logDir, 'vendor.previous.log'));
  }
} catch { /* a log we cannot rotate is not a reason to refuse to run */ }

let logFd = null;
try { logFd = openSync(logFile, 'a'); } catch { logFd = null; }

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
function record(line) {
  if (logFd === null) return;
  try { writeSync(logFd, `${stamp()}  ${line}\n`); } catch { /* disk full */ }
}

const toLine = (args) => format(...args);
console.log = (...args) => record(toLine(args));
console.info = console.log;
console.debug = console.log;
console.warn = (...args) => record(`WARN  ${toLine(args)}`);
console.error = (...args) => record(`ERROR ${toLine(args)}`);
for (const stream of ['stdout', 'stderr']) {
  try {
    process[stream].write = (chunk) => {
      record(String(chunk).replace(/\r?\n$/, ''));
      return true;
    };
  } catch { /* the stream is not writable; the console override still holds */ }
}

/* --------------------------------------------------------------------- telling off */

/** A PowerShell single-quoted literal: the only escape inside one is a doubled quote. */
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

function dialog(title, detail, kind) {
  record(`${kind === 'Error' ? 'FATAL' : 'NOTE '} ${title}: ${detail}`);
  const messageFile = join(logDir, 'last-message.txt');
  try { writeFileSync(messageFile, `${title}\n\n${detail}`, 'utf8'); } catch { return; }
  try {
    spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms;'
      + `[System.Windows.Forms.MessageBox]::Show([IO.File]::ReadAllText(${quote(messageFile)}),`
      + ` 'QServe Vendor', 'OK', '${kind}') | Out-Null`,
    ], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* no dialog is possible; the log is still written */ }
}

const fatal = (title, detail) => dialog(title, detail, 'Error');
const notice = (title, detail) => dialog(title, detail, 'Information');

process.on('uncaughtException', (error) => {
  fatal('The licence server stopped unexpectedly.', error?.stack ?? String(error));
  process.exitCode = 1;
});
process.on('unhandledRejection', (reason) => {
  record(`UNHANDLED ${reason?.stack ?? String(reason)}`);
});

/* ---------------------------------------------------------------------- unpacking */

/** Read a ZIP built by `packaging/lib/zip.mjs`. See the restaurant launcher. */
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

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, method === 8 ? inflateRawSync(raw) : raw);
  }
}

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

  try {
    for (const entry of readdirSync(runtimeRoot)) {
      if (entry !== digest) rmSync(join(runtimeRoot, entry), { recursive: true, force: true });
    }
  } catch { /* an old copy left behind wastes disk, nothing more */ }
  return target;
}

/* ------------------------------------------------------------------- the browser */

function openBrowser(url) {
  try {
    spawn(process.env.COMSPEC || 'cmd', ['/c', 'start', '""', url], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
  } catch (error) {
    record(`could not open a browser: ${error?.message ?? error}`);
  }
}

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
  const port = Number(process.env.QSERVE_LS_PORT ?? 8090);
  const consoleUrl = `http://127.0.0.1:${port}/admin`;

  if (await alreadyRunning(port)) {
    record('the licence server is already running; bringing its console forward');
    openBrowser(consoleUrl);
    return;
  }

  let appRoot;
  let sea = null;
  try { sea = require('node:sea'); } catch { sea = null; }

  if (sea?.isSea?.()) {
    appRoot = unpack(Buffer.from(sea.getAsset('payload.zip')));
  } else {
    appRoot = dirname(process.execPath);
    record(`not a packed build; running from ${appRoot}`);
  }

  const entry = join(appRoot, 'app', 'license-server', 'dist', 'main.js');
  if (!existsSync(entry)) {
    fatal('QServe Vendor could not find its application files.',
      `Expected them at:\n${entry}\n\nDownload the file again.`);
    process.exitCode = 1;
    return;
  }

  /*
   * The signing key: the one thing this program cannot invent.
   *
   * Every licence a restaurant ever activates is verified against the public
   * half of this key, baked into the restaurant's own build. Losing it means
   * no existing installation can be given a new licence again — so it is kept
   * outside the runtime folder, which is deleted and rewritten on every
   * upgrade, and the first launch says where it is.
   */
  const keyFile = process.env.QSERVE_LS_SIGNING_KEY_FILE ?? join(secretsDir, 'signing-key.json');
  const trustFile = join(secretsDir, 'trusted-keys.json');
  const firstRun = !existsSync(keyFile);

  if (firstRun) {
    /*
     * Make the key rather than ask for it.
     *
     * From a checkout this is `npm run keygen`, which is the right shape for
     * somebody who already has a terminal open. A vendor who downloaded one
     * .exe has not, and a licence server that starts without a key would look
     * like it works right up until the first sale. `main()` refuses to
     * overwrite an existing key, so this cannot run twice by accident.
     */
    const keygen = await import(pathToFileURL(
      join(appRoot, 'app', 'license-server', 'dist', 'tools', 'keygen.js')).href);
    keygen.main([`--out=${keyFile}`, `--trust=${trustFile}`]);
    record(`generated a signing key at ${keyFile}`);
  }

  const env = process.env;
  env.QSERVE_LS_DATA_DIR = dataDir;
  env.QSERVE_LS_SIGNING_KEY_FILE = keyFile;
  env.QSERVE_LS_PORT = String(port);

  mkdirSync(dataDir, { recursive: true });
  record(`QServe Vendor starting — data ${dataDir}, runtime ${appRoot}`);

  if (firstRun) {
    // Said once, loudly. A vendor who does not back this up has one very bad
    // day somewhere ahead of them, and it will arrive without warning.
    notice('QServe Vendor is set up.',
      'Your signing key has been created at:\n'
      + `${keyFile}\n\n`
      + 'BACK THIS FILE UP TODAY, somewhere that is not this computer. Every '
      + 'licence you ever issue is verified against it. It cannot be recovered '
      + 'or reissued — losing it means no restaurant you have already sold to '
      + 'can ever be given a new licence.\n\n'
      + 'The public half, which goes into the restaurant builds you ship, is at:\n'
      + `${trustFile}\n`
      + 'That one is not secret.\n\n'
      + 'Your first sign-in password is written once to:\n'
      + `${logFile}`);
  }

  let started;
  try {
    const server = await import(pathToFileURL(entry).href);
    started = await server.start();
  } catch (error) {
    fatal('QServe Vendor could not start.',
      `${error?.message ?? error}\n\n`
      + `This is usually port ${port} already in use, or a data folder it is `
      + 'not allowed to write to.');
    process.exitCode = 1;
    return;
  }

  record(`vendor console listening on ${consoleUrl}`);
  openBrowser(consoleUrl);

  const shutdown = () => {
    record('shutting down');
    Promise.resolve(started?.close?.())
      .catch((error) => record(`shutdown failed: ${error?.stack ?? error}`))
      .finally(() => {
        if (logFd !== null) { try { closeSync(logFd); } catch { /* closing */ } }
        process.exit(0);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  fatal('QServe Vendor could not start.', error?.stack ?? String(error));
  process.exitCode = 1;
});
