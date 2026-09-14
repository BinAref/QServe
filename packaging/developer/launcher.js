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
 * The page ships inside this download rather than being hosted because Supabase
 * deliberately answers HTML from its own domain as plain text inside a sandbox,
 * so that a page served there cannot run same-origin with the API. Shipping the
 * console inside the download is the better answer anyway: nothing to keep
 * online, and it works the moment it is installed.
 *
 * It used to be opened as a file. It is now served on http://localhost instead,
 * for one reason: a file:// page has no domain, and WebAuthn refuses to make or
 * use a passkey for an origin that is not a domain — so Windows Hello could
 * never have worked from a file. The server binds to the loopback address, has
 * three routes, and shuts itself down when the page stops answering.
 */

'use strict';

const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const http = require('node:http');
const {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync, writeSync,
} = require('node:fs');
const { dirname, extname, join, resolve } = require('node:path');
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

/* -------------------------------------------------------------------- serving */

/*
 * The port is remembered, because the browser's storage is tied to it.
 *
 * A passkey belongs to the host name, so it would survive a change of port —
 * but everything beside it does not: the saved sign-in, the archive of deleted
 * licences and the Windows Hello enrolment all live in localStorage, which is
 * per origin, and an origin includes the port. Coming back on a different port
 * would look exactly like a new computer.
 */
const PORT_FILE = join(home, 'port.txt');
const FALLBACK_PORTS = [8787, 8788, 8789, 8790, 8791, 8792, 8793, 8794, 8795];

function preferredPorts() {
  let remembered = null;
  try {
    remembered = Number.parseInt(readFileSync(PORT_FILE, 'utf8').trim(), 10) || null;
  } catch { /* first run */ }
  return remembered
    ? [remembered, ...FALLBACK_PORTS.filter((port) => port !== remembered)]
    : FALLBACK_PORTS;
}

/** Is the thing already on this port our own console? */
async function alreadyOurs(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/whoami`, {
      signal: AbortSignal.timeout(1200),
    });
    return res.ok && (await res.text()).trim() === MARK;
  } catch {
    return false;
  }
}

const MARK = 'qserve-vendor-console';

/*
 * Only requests that arrive addressed to this machine are answered.
 *
 * A loopback server is reachable from any page in any browser on it, and the
 * old trick is to point a name you control at 127.0.0.1 and then read from it
 * as though it were yours. The browser sends the name it dialled in `Host`, so
 * refusing every name but localhost closes that: an attacker's domain cannot
 * pretend to be one.
 */
function addressedToUs(request, port) {
  const host = String(request.headers.host ?? '').toLowerCase();
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`;
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/**
 * Serve the console, and stop when it is no longer being looked at.
 *
 * The page beats every ten seconds while it is open. Nothing beating for a
 * minute means the tab is closed or the browser is gone, and a licence console
 * that keeps a process alive for the rest of the day after being closed is a
 * thing people find in Task Manager and distrust.
 */
function serve(page, port) {
  let lastBeat = Date.now();
  let everBeat = false;

  const server = http.createServer((request, response) => {
    if (!addressedToUs(request, port)) {
      response.writeHead(403).end('not for you');
      return;
    }
    const path = new URL(request.url, 'http://localhost').pathname;

    if (path === '/whoami') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end(MARK);
      return;
    }
    if (path === '/alive') {
      lastBeat = Date.now();
      everBeat = true;
      response.writeHead(204).end();
      return;
    }
    if (path === '/' || path === '/index.html') {
      let html;
      try {
        html = readFileSync(page);
      } catch (error) {
        response.writeHead(500).end('the console could not be read');
        return;
      }
      response.writeHead(200, {
        'content-type': CONTENT_TYPES['.html'],
        // Always the copy this build shipped, never one an upgrade replaced.
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      }).end(html);
      return;
    }
    response.writeHead(404).end('no');
  });

  server.on('error', (error) => {
    record(`the server stopped: ${error?.message ?? error}`);
  });

  /*
   * Two clocks. A browser that never arrives (no default browser, a blocked
   * `start`) must not leave this running for ever either, so an opening that
   * is never taken up gives up after two minutes.
   */
  const IDLE_MS = 60_000;
  const NEVER_OPENED_MS = 120_000;
  const started = Date.now();
  const watchdog = setInterval(() => {
    const quiet = Date.now() - lastBeat;
    if (everBeat ? quiet > IDLE_MS : Date.now() - started > NEVER_OPENED_MS) {
      record(everBeat ? 'the console was closed; shutting down'
        : 'nothing ever opened the console; shutting down');
      clearInterval(watchdog);
      server.close(() => process.exit(0));
      // A browser holding a keep-alive socket would otherwise stall the close.
      setTimeout(() => process.exit(0), 1500).unref();
    }
  }, 5000);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/* ------------------------------------------------------------------------- start */

/**
 * Open the console.
 *
 * This executable used to *be* the licence server: it listened on a port,
 * restaurants activated against it, and the vendor had to keep the machine on
 * and reachable for anybody to be able to buy anything. The licences live in
 * Supabase now, so there is nothing here that a restaurant depends on. What is
 * left is a way to put the console in front of the person who sells QServe,
 * on an address a browser will treat as a real origin, for as long as they
 * have it open.
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

  const packed = join(appRoot, 'console.html');
  if (!existsSync(packed)) {
    fatal('QServe Vendor could not find its console.',
      `Expected it at:\n${packed}\n\nDownload the file again.`);
    process.exitCode = 1;
    return;
  }

  /*
   * A copy outside the runtime folder, because that folder is deleted and
   * rewritten on every upgrade.
   */
  const page = join(home, 'console.html');
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(page, readFileSync(packed));
  } catch (error) {
    record(`could not place the console at ${page}: ${error?.message ?? error}`);
  }
  const serving = existsSync(page) ? page : packed;

  /* ------------------------------------------------- one console, not five */

  for (const port of preferredPorts()) {
    if (await alreadyOurs(port)) {
      record(`the console is already being served on ${port}; opening that one`);
      openBrowser(`http://localhost:${port}/`);
      if (logFd !== null) { try { closeSync(logFd); } catch { /* closing */ } }
      return;
    }
  }

  let port = null;
  for (const candidate of preferredPorts()) {
    try {
      await serve(serving, candidate);
      port = candidate;
      break;
    } catch (error) {
      record(`port ${candidate} would not take it: ${error?.code ?? error?.message ?? error}`);
    }
  }

  if (port === null) {
    fatal('QServe Vendor could not open its console.',
      'Every address it tried was busy. Close whatever is using ports 8787 to '
      + '8795, or restart the computer, and try again.');
    process.exitCode = 1;
    return;
  }

  try { writeFileSync(PORT_FILE, `${port}\n`); } catch { /* remembered next time, or not */ }

  const address = `http://localhost:${port}/`;
  record(`serving the vendor console at ${address}`);
  openBrowser(address);

  if (!existsSync(join(home, 'opened-once'))) {
    try { writeFileSync(join(home, 'opened-once'), `${new Date().toISOString()}\n`); }
    catch { /* the notice is nice to have, not load-bearing */ }
    notice('QServe Vendor',
      'The licence console has opened in your browser.\n\n'
      + 'Sign in with the vendor account for your Supabase project. Everything '
      + 'you do there — issuing a licence, withdrawing one — happens in the '
      + 'database directly, so there is nothing for a restaurant to depend on.\n\n'
      + 'In Account you can change your password and switch on Windows Hello, '
      + 'so your face or fingerprint opens it instead.\n\n'
      + `The address is:\n${address}\n\n`
      + 'This program serves that page and closes itself a minute after you '
      + 'close the tab. Run it again whenever you need the console.');
  }
}

main().catch((error) => {
  fatal('QServe Vendor could not start.', error?.stack ?? String(error));
  process.exitCode = 1;
});
