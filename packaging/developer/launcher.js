/*
 * QServe Vendor.exe — the licence console, for the person who sells QServe.
 *
 * This is not a thing a restaurant ever runs. It is the other half of the
 * commercial arrangement: it is where licence keys are issued, moved and
 * withdrawn, and where the record of who bought what is read.
 *
 * It used to *be* the licence server — it listened on a port, restaurants
 * activated against it, and the vendor had to keep this machine switched on
 * and reachable for anybody to be able to buy anything. The licences live in
 * Supabase now, which means there is nothing here to run: this program unpacks
 * one page and opens it in a browser. Same shape as the restaurant's
 * executable — one file, no console window, everything unpacked on first run —
 * and then it exits.
 *
 * The page is a local file rather than a hosted address because Supabase
 * deliberately answers HTML from its own domain as plain text inside a sandbox,
 * so that a page served there cannot run same-origin with the API. Shipping the
 * console inside the download is the better answer anyway: nothing to keep
 * online, and it works the moment it is installed.
 */

'use strict';

const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync, writeSync,
} = require('node:fs');
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
    const child = spawn(process.env.COMSPEC || 'cmd', ['/c', 'start', '""', url], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    /*
     * A spawn that cannot find its command fails on the 'error' event, not by
     * throwing — so the try/catch around it never sees it, the event goes
     * unhandled, and the program dies. On a machine with an unusual COMSPEC the
     * vendor would meet a crash dialog instead of their console, having already
     * had the console written to disk perfectly well.
     */
    child.on('error', (error) => {
      record(`could not open a browser: ${error?.message ?? error}`);
    });
    child.unref();
  } catch (error) {
    record(`could not open a browser: ${error?.message ?? error}`);
  }
}

/* ------------------------------------------------------------------------- start */

/**
 * Open the console, and that is all.
 *
 * This executable used to *be* the licence server: it listened on a port,
 * restaurants activated against it, and the vendor had to keep the machine on
 * and reachable for anybody to be able to buy anything. The licences live in
 * Supabase now, so there is nothing here to run — the whole program is a
 * shortcut that unpacks a page and hands it to a browser.
 *
 * The page is a file on disk rather than a hosted address on purpose. Supabase
 * answers HTML from its own domain with `content-type: text/plain` and a
 * sandbox policy, deliberately, so that a page served there cannot run
 * same-origin with the API. Rather than find somewhere else to host it, the
 * console ships inside this download: nothing to keep online, and it works the
 * moment it is installed.
 */
async function main() {
  let appRoot;
  let sea = null;
  try { sea = require('node:sea'); } catch { sea = null; }

  if (sea?.isSea?.()) {
    appRoot = unpack(Buffer.from(sea.getAsset('payload.zip')));
  } else {
    appRoot = dirname(process.execPath);
    record(`not a packed build; running from ${appRoot}`);
  }

  const page = join(appRoot, 'console.html');
  if (!existsSync(page)) {
    fatal('QServe Vendor could not find its console.',
      `Expected it at:\n${page}\n\nDownload the file again.`);
    process.exitCode = 1;
    return;
  }

  /*
   * A copy outside the runtime folder, because that folder is deleted and
   * rewritten on every upgrade — and a vendor who bookmarked the console would
   * find the bookmark broken the first time they updated.
   */
  const stable = join(home, 'console.html');
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(stable, readFileSync(page));
  } catch (error) {
    record(`could not place the console at ${stable}: ${error?.message ?? error}`);
  }

  const target = existsSync(stable) ? stable : page;
  record(`opening the vendor console at ${target}`);
  openBrowser(pathToFileURL(target).href);

  if (!existsSync(join(home, 'opened-once'))) {
    try { writeFileSync(join(home, 'opened-once'), `${new Date().toISOString()}\n`); }
    catch { /* the notice is nice to have, not load-bearing */ }
    notice('QServe Vendor',
      'The licence console has opened in your browser.\n\n'
      + 'Sign in with the vendor account for your Supabase project. Everything '
      + 'you do there — issuing a licence, moving one, withdrawing one — happens '
      + 'in the database directly, so there is nothing on this computer to keep '
      + 'running and nothing for a restaurant to depend on.\n\n'
      + `You can also open it again at any time from:\n${target}`);
  }

  if (logFd !== null) { try { closeSync(logFd); } catch { /* closing */ } }
}

main().catch((error) => {
  fatal('QServe Vendor could not start.', error?.stack ?? String(error));
  process.exitCode = 1;
});
