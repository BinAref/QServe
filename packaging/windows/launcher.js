/*
 * QServe.exe — the thing an owner double-clicks.
 *
 * The whole product is inside this one file: Node's SEA support bakes this
 * launcher into a copy of the Node runtime, and the runtime then loads the
 * server that sits beside it in `app\`. There is no second executable to ship
 * and nothing for the owner to install — unzip the folder, run the file.
 *
 * It is CommonJS because that is what a SEA main script is loaded as; the
 * server itself is ordinary ES modules on disk, imported from here.
 */

'use strict';

const { spawn } = require('node:child_process');
const { existsSync, mkdirSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');

/** Where the bundle lives: this executable's own folder. */
const home = dirname(process.execPath);
const entry = join(home, 'app', 'server', 'dist', 'main.js');

/**
 * The restaurant's data — its menu, its orders, its licence — never lives
 * inside the program folder. Upgrading QServe means replacing that folder, and
 * that must never be able to take the restaurant with it.
 */
const dataDir = join(process.env.LOCALAPPDATA || join(home, 'data'), 'QServe', 'data');

if (!existsSync(entry)) {
  process.stdout.write(
    '\nQServe is missing its app folder.\n'
    + 'Unzip the whole QServe folder, and run QServe.exe from inside it.\n\n',
  );
  process.exit(1);
}

mkdirSync(dataDir, { recursive: true });
process.env.QSERVE_DATA_DIR = process.env.QSERVE_DATA_DIR ?? dataDir;

const port = Number(process.env.QSERVE_ADMIN_PORT ?? 7010);
const consoleUrl = `http://127.0.0.1:${port}/console/`;

process.stdout.write('\nQServe — Local Restaurant Operating System\n');
process.stdout.write(`Data:    ${process.env.QSERVE_DATA_DIR}\n`);
process.stdout.write(`Console: ${consoleUrl}\n`);
process.stdout.write('\nKeep this window open while the restaurant is trading.\n\n');

import(pathToFileURL(entry).href)
  .then((server) => server.start())
  .then(() => {
    // The console is opened once the listener is actually up, so nobody's
    // first ever launch meets a refused connection.
    spawn('cmd', ['/c', 'start', '""', consoleUrl], { detached: true, stdio: 'ignore' }).unref();
  })
  .catch((error) => {
    process.stdout.write(`\nQServe could not start:\n${error?.stack ?? error}\n\n`);
    process.stdout.write('Press Ctrl+C to close this window.\n');
    process.exitCode = 1;
  });
