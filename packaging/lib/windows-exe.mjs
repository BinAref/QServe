/**
 * Turning a staged folder into one Windows executable.
 *
 * Two of the three things this repository ships are a Node server that has to
 * arrive as a single file somebody double-clicks: the restaurant's own server,
 * and the vendor's licence server. They stage different payloads and they have
 * different launchers, but everything from there on — fetch a Node runtime, zip
 * the payload, bake both into the runtime, stop Windows opening a console — is
 * the same work, and was worth having in one place rather than two.
 *
 * The two things this does that are easy to get wrong are documented where they
 * happen: the SEA fuse, and the PE subsystem byte.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { platform } from 'node:process';

import { makeZip } from './zip.mjs';

export const say = (message) => process.stdout.write(`\n▸ ${message}\n`);

/*
 * Run a tool. On Windows `npm` and `npx` are `.cmd` files, which cannot be
 * spawned directly — hence the shell — and going through a shell means the
 * arguments have to be quoted ourselves. The command needs the same treatment:
 * Node itself lives under "C:\Program Files" on a normal install, and unquoted
 * that is a command called `C:\Program` with a stray argument after it.
 */
export const run = (command, args, options = {}) => {
  process.stdout.write(`  $ ${command} ${args.join(' ')}\n`);
  const shell = platform === 'win32';
  const quote = (value) => (/[\s&|<>^]/.test(value) ? `"${value}"` : value);
  const quoted = shell ? args.map(quote) : args;
  return execFileSync(shell ? quote(command) : command, quoted,
    { stdio: 'inherit', shell, ...options });
};

/**
 * Everything a compiler leaves behind that is not the product.
 *
 * `better-sqlite3` normally arrives prebuilt and this matters not at all. On a
 * machine with no prebuild for its Node version it is compiled instead, and
 * then `build/` holds object files, import libraries and ten megabytes of PDB
 * symbols beside the one `.node` that is actually loaded. Whether a restaurant
 * downloads 91 MB or 108 MB should not depend on whose machine cut the release.
 */
const COMPILER_LEFTOVERS = ['.pdb', '.ipdb', '.iobj', '.obj', '.lib', '.exp', '.map'];
const nativeLeftover = (source) =>
  source.includes(`${sep}build${sep}`)
  && (source.includes(`${sep}obj${sep}`)
    || source.includes(`${sep}deps${sep}`)
    || COMPILER_LEFTOVERS.some((extension) => source.endsWith(extension)));

/** Type declarations, source maps and tests are for whoever builds this, not who runs it. */
export const shippable = (source) =>
  !source.includes(`${sep}dist${sep}tests`)
  && !source.endsWith('.d.ts') && !source.endsWith('.d.ts.map') && !source.endsWith('.js.map');

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : [full];
});

/**
 * Copy the workspace packages into a staged `node_modules`.
 *
 * ORDER MATTERS, and this is why it is a function rather than four lines in two
 * build scripts. `npm install` reifies node_modules to match package.json and
 * deletes anything extraneous; the `@qserve/*` packages are deliberately not in
 * that list because they are copied, not fetched. Staged before the install
 * they are staged into the bin — which is exactly how a build once shipped an
 * executable that opened, said it could not find `@qserve/shared`, and closed.
 *
 * So: write the package.json, install, and only then call this.
 */
export function stageWorkspacePackages(repo, app, names) {
  for (const name of names) {
    const from = join(repo, 'packages', name);
    const to = join(app, 'node_modules/@qserve', name);
    cpSync(join(from, 'dist'), join(to, 'dist'), { recursive: true, filter: shippable });
    cpSync(join(from, 'package.json'), join(to, 'package.json'));
  }
}

/** Fail the build rather than ship an executable that cannot start. */
export function checkPayload(stage, required) {
  say('checking the payload');
  const missing = required.filter((path) => !existsSync(join(stage, path)));
  if (missing.length > 0) {
    throw new Error(`the payload is incomplete:\n  ${missing.join('\n  ')}`);
  }
  process.stdout.write(`  ${required.length} required paths present\n`);
}

/**
 * Re-mark an executable as a GUI program.
 *
 * A copy of node.exe is a console program, and Windows opens a black window for
 * one of those before a single line of our code runs — there is no flag, no
 * argument and no API that prevents it from the inside. The only thing that
 * decides it is one 16-bit field in the PE header, and this rewrites it: 3
 * (Windows CUI) becomes 2 (Windows GUI).
 *
 * The field sits at a fixed offset in the optional header, the same offset for
 * both 32- and 64-bit images, because the fields that differ between them are
 * all before it and cancel out. The header checksum is left stale, as postject
 * leaves it: Windows verifies it for drivers, not for programs.
 */
function markAsGuiProgram(file) {
  const image = readFileSync(file);
  if (image.readUInt16LE(0) !== 0x5a4d) throw new Error(`${file} is not a PE image`);

  const peHeader = image.readUInt32LE(0x3c);
  if (image.readUInt32LE(peHeader) !== 0x00004550) throw new Error(`${file} has no PE signature`);

  const optionalHeader = peHeader + 24;
  const magic = image.readUInt16LE(optionalHeader);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`${file}: unknown PE optional header`);

  const subsystemAt = optionalHeader + 68;
  const subsystem = image.readUInt16LE(subsystemAt);
  if (subsystem === 2) return 'already a GUI program';
  if (subsystem !== 3) throw new Error(`${file}: unexpected subsystem ${subsystem}`);

  image.writeUInt16LE(2, subsystemAt);
  writeFileSync(file, image);
  return 'console subsystem 3 → GUI subsystem 2';
}

/**
 * Zip a staged folder, bake it into a Node runtime beside a launcher, and hand
 * back one executable that opens no window.
 *
 * `mustContain` is checked against the zipped file list rather than the folder,
 * because the leftover filter runs between the two and has taken too much
 * before.
 */
export async function buildExecutable({
  build, stage, launcher, exe, nodeVersion, mustContain = [],
}) {
  say('packing the payload');
  // Sorted, so two builds of the same source produce the same archive and a
  // release can be checked by rebuilding it.
  const staged = walk(stage).sort();
  const files = staged.filter((file) => !nativeLeftover(file));
  const dropped = staged.length - files.length;

  for (const needle of mustContain) {
    if (!files.some((file) => file.endsWith(needle))) {
      throw new Error(`the payload lost ${needle} — the leftover filter took too much`);
    }
  }

  const payload = makeZip(files.map((file) => [
    relative(stage, file).split(sep).join('/'),
    readFileSync(file),
  ]));
  const payloadFile = join(build, 'payload.zip');
  writeFileSync(payloadFile, payload);
  process.stdout.write(
    `  ${files.length} files, ${(payload.length / 1024 / 1024).toFixed(1)} MB compressed`
    + `${dropped > 0 ? ` (${dropped} compiler leftovers dropped)` : ''}\n`,
  );

  /* ------------------------------------------------- the runtime to ship on */

  say(`fetching node ${nodeVersion} for windows-x64`);
  const nodeZip = join(build, `node-v${nodeVersion}-win-x64.zip`);
  const nodeUrl = `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-win-x64.zip`;

  if (!existsSync(nodeZip)) {
    const response = await fetch(nodeUrl);
    if (!response.ok) throw new Error(`${nodeUrl} → ${response.status}`);
    writeFileSync(nodeZip, Buffer.from(await response.arrayBuffer()));
  }

  const unpacked = join(build, `node-v${nodeVersion}-win-x64`);
  if (!existsSync(join(unpacked, 'node.exe'))) {
    if (platform === 'win32') {
      run('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -Path '${nodeZip}' -DestinationPath '${build}' -Force`]);
    } else {
      run('unzip', ['-q', '-o', nodeZip, '-d', build]);
    }
  }
  const nodeExe = join(unpacked, 'node.exe');
  if (!existsSync(nodeExe)) throw new Error(`no node.exe in ${nodeUrl}`);

  /* ------------------------------------------------------------ the exe */

  say(`building ${basename(exe)}`);
  const seaConfig = join(build, 'sea-config.json');
  writeFileSync(seaConfig, `${JSON.stringify({
    main: launcher,
    output: join(build, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: { 'payload.zip': payloadFile },
  }, null, 2)}\n`);

  run(process.execPath, ['--experimental-sea-config', seaConfig], { cwd: build });

  mkdirSync(join(exe, '..'), { recursive: true });
  rmSync(exe, { force: true });
  cpSync(nodeExe, exe);

  // The fuse is the sentinel postject overwrites to tell the runtime a blob is
  // attached. It is a fixed string in every Node build and is not a version.
  run('npx', ['--yes', 'postject', exe, 'NODE_SEA_BLOB', join(build, 'sea-prep.blob'),
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { cwd: build });

  say('removing the console window');
  process.stdout.write(`  ${markAsGuiProgram(exe)}\n`);

  return { megabytes: (statSync(exe).size / 1024 / 1024).toFixed(0) };
}
