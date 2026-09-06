/**
 * Image storage for logos and menu photography (spec §34).
 *
 * Images live on disk under `data/restaurant/assets/`, addressed by a
 * content hash, and are carried whole inside encrypted backups. Storing them
 * outside the database keeps SQLite small and lets the operating system's page
 * cache serve a busy dinner service without going through the query engine.
 */

import { createHash } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '@qserve/db';
import { nowIso } from '@qserve/db';
import { newEntityId, notFound, validationError, type Actor } from '@qserve/shared';
import type { AuditRepository } from '../../core/repositories/audit.js';
import type { Paths } from '../../core/paths.js';

/** Formats a browser can display without a plugin, and that we can size-check. */
const ALLOWED_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

const MAX_BYTES = 4 * 1024 * 1024;

export interface AssetRow {
  id: string;
  kind: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  file_name: string;
  created_at: string;
}

export class AssetService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditRepository,
    private readonly paths: Paths,
  ) {}

  async store(input: {
    bytes: Buffer;
    contentType: string;
    kind: 'logo' | 'product' | 'category';
    actor: Actor;
    clientIp: string | null;
  }): Promise<AssetRow> {
    const extension = ALLOWED_TYPES[input.contentType];
    if (!extension) {
      throw validationError('unsupported image type', {
        field: 'contentType', allowed: Object.keys(ALLOWED_TYPES),
      });
    }
    if (input.bytes.length === 0) {
      throw validationError('the uploaded file is empty', { field: 'file' });
    }
    if (input.bytes.length > MAX_BYTES) {
      throw validationError('images must be 4 MB or smaller', {
        field: 'file', maxBytes: MAX_BYTES,
      });
    }
    if (!looksLikeImage(input.bytes, input.contentType)) {
      // The declared content type is attacker-controlled; check the magic bytes
      // so an uploaded script cannot be served back as an image.
      throw validationError('the file content does not match its declared type', {
        field: 'file',
      });
    }

    const sha256 = createHash('sha256').update(input.bytes).digest('hex');

    // Content addressing means uploading the same photo for ten products costs
    // one copy on disk and one row.
    const existing = this.db.prepare('SELECT * FROM assets WHERE sha256 = ?').get(sha256) as
      | AssetRow
      | undefined;
    if (existing) return existing;

    const id = newEntityId('AST');
    const fileName = `${id}.${extension}`;
    await writeFile(join(this.paths.assetsDir, fileName), input.bytes);

    this.db
      .prepare(`
        INSERT INTO assets (id, kind, content_type, byte_size, sha256, file_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(id, input.kind, input.contentType, input.bytes.length, sha256, fileName, nowIso());

    this.audit.record({
      action: 'asset.uploaded',
      actor: input.actor,
      entityType: 'asset',
      entityId: id,
      detail: { kind: input.kind, contentType: input.contentType, byteSize: input.bytes.length },
      clientIp: input.clientIp,
    });

    return this.get(id)!;
  }

  get(id: string): AssetRow | null {
    return (this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow | undefined)
      ?? null;
  }

  async read(id: string): Promise<{ bytes: Buffer; contentType: string }> {
    const row = this.get(id);
    if (!row) throw notFound('asset', id);
    try {
      return {
        bytes: await readFile(join(this.paths.assetsDir, row.file_name)),
        contentType: row.content_type,
      };
    } catch {
      throw notFound('asset file', id);
    }
  }

  list(kind?: string): AssetRow[] {
    return kind
      ? (this.db
          .prepare('SELECT * FROM assets WHERE kind = ? ORDER BY created_at DESC')
          .all(kind) as AssetRow[])
      : (this.db.prepare('SELECT * FROM assets ORDER BY created_at DESC').all() as AssetRow[]);
  }

  async delete(input: { id: string; actor: Actor; clientIp: string | null }): Promise<void> {
    const row = this.get(input.id);
    if (!row) throw notFound('asset', input.id);

    // Refuse while anything still points at it, so a menu never renders a hole.
    const references = this.db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM products   WHERE image_asset_id = ?) +
          (SELECT COUNT(*) FROM categories WHERE image_asset_id = ?) +
          (SELECT COUNT(*) FROM restaurant WHERE logo_asset_id  = ?) AS uses
      `)
      .get(input.id, input.id, input.id) as { uses: number };

    if (references.uses > 0) {
      throw validationError('this image is still used by the menu', {
        field: 'id', uses: references.uses,
      });
    }

    await unlink(join(this.paths.assetsDir, row.file_name)).catch(() => {});
    this.db.prepare('DELETE FROM assets WHERE id = ?').run(input.id);

    this.audit.record({
      action: 'asset.deleted',
      actor: input.actor,
      entityType: 'asset',
      entityId: input.id,
      clientIp: input.clientIp,
    });
  }
}

/** Magic-byte sniffing for the formats we accept. */
function looksLikeImage(bytes: Buffer, contentType: string): boolean {
  const startsWith = (...signature: number[]): boolean =>
    signature.every((byte, index) => bytes[index] === byte);

  switch (contentType) {
    case 'image/png':
      return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'image/jpeg':
      return startsWith(0xff, 0xd8, 0xff);
    case 'image/gif':
      return startsWith(0x47, 0x49, 0x46, 0x38);
    case 'image/webp':
      return startsWith(0x52, 0x49, 0x46, 0x46) &&
        bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    case 'image/svg+xml': {
      const head = bytes.subarray(0, 1024).toString('utf8').trimStart().toLowerCase();
      // SVG is XML, so it can carry script. It is served with a CSP that blocks
      // inline execution, but reject the obvious cases up front anyway.
      if (head.includes('<script') || head.includes('javascript:')) return false;
      return head.startsWith('<?xml') || head.startsWith('<svg');
    }
    default:
      return false;
  }
}
