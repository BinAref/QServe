/**
 * A ZIP writer, in about a hundred lines.
 *
 * The Windows build ships as one executable with the whole application inside
 * it, which means the build has to produce an archive and the launcher has to
 * open one. Both halves are written here rather than taken from npm, for the
 * same reason the product has three runtime dependencies and not three hundred:
 * this is a file format from 1989 with a published specification, and a
 * restaurant's till should not inherit somebody else's dependency tree to
 * unpack itself.
 *
 * Only the two features that matter are implemented — stored and deflated
 * entries, no encryption, no zip64. The payload is tens of megabytes, well
 * inside the 4 GB the classic format addresses.
 *
 * The reader is not here. It lives inlined in `launcher.js`, because a SEA
 * executable bakes in exactly one script and cannot import a sibling.
 */

import { deflateRawSync } from 'node:zlib';

/* CRC-32, the checksum the format was specified with. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/*
 * MS-DOS date and time, which is what the format stores. Every entry is given
 * the same fixed timestamp on purpose: two builds of the same source should
 * produce the same bytes, so a release can be checked by rebuilding it.
 */
const DOS_TIME = 0;               // 00:00:00
const DOS_DATE = (1980 - 1980) << 9 | 1 << 5 | 1;  // 1980-01-01

/**
 * Build a ZIP from `[path, contents]` pairs. Paths use forward slashes, which
 * is what the specification asks for regardless of the machine writing it.
 */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [rawName, contents] of entries) {
    const name = Buffer.from(rawName.replace(/\\/g, '/'), 'utf8');
    const body = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    const sum = crc32(body);

    // Deflate unless it makes the entry bigger, which it does for anything
    // already compressed — a PNG in the menu, the icons in the web root.
    const packed = deflateRawSync(body, { level: 9 });
    const deflated = packed.length < body.length;
    const stored = deflated ? packed : body;
    const method = deflated ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flags: names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // no extra field
    locals.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk
    central.writeUInt16LE(0, 36);         // internal attributes
    central.writeUInt32LE(0, 38);         // external attributes
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + stored.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);                // this disk
  end.writeUInt16LE(0, 6);                // disk with the directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);               // no archive comment

  return Buffer.concat([...locals, directory, end]);
}
