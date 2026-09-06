/**
 * Static asset serving for the terminal front-ends.
 *
 * The front-ends are plain ES modules with no build step, so the server hands
 * them out directly. That is a deliberate choice for an offline product: there
 * is no bundle to rebuild on a restaurant PC and no toolchain to install.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { normalize, resolve, sep, extname } from 'node:path';
import { createHash } from 'node:crypto';
import type { RequestContext } from './types.js';
import { HttpResponse } from './types.js';

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

export const contentTypeFor = (path: string): string =>
  MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

export interface StaticOptions {
  readonly root: string;
  /** Served when the requested path is a directory or has no extension. */
  readonly indexFile?: string;
  /** Serve `indexFile` for unknown paths — needed by client-side routing. */
  readonly spaFallback?: boolean;
  /** `Cache-Control` for hashed/immutable assets. HTML is always revalidated. */
  readonly cacheControl?: string;
}

/**
 * Resolve a URL path inside `root`, refusing anything that escapes it.
 * Returns null for traversal attempts rather than throwing, so the caller can
 * answer 404 and reveal nothing about the filesystem layout.
 */
export function safeResolve(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const rootResolved = resolve(root);
  const candidate = resolve(rootResolved, `.${normalize(`/${decoded}`)}`);
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) return null;
  return candidate;
}

export function createStaticHandler(options: StaticOptions) {
  const indexFile = options.indexFile ?? 'index.html';
  const cacheControl = options.cacheControl ?? 'public, max-age=300';

  return async (ctx: RequestContext): Promise<HttpResponse | undefined> => {
    const requested = (ctx.params['wildcard'] ?? ctx.path) || '/';
    let filePath = safeResolve(options.root, requested);
    if (!filePath) return new HttpResponse(404, 'not found');

    let info = await stat(filePath).catch(() => null);

    if (info?.isDirectory()) {
      filePath = safeResolve(options.root, `${requested}/${indexFile}`);
      info = filePath ? await stat(filePath).catch(() => null) : null;
    }

    if (!info?.isFile()) {
      if (!options.spaFallback) return new HttpResponse(404, 'not found');
      filePath = safeResolve(options.root, indexFile);
      info = filePath ? await stat(filePath).catch(() => null) : null;
      if (!info?.isFile() || !filePath) return new HttpResponse(404, 'not found');
    }
    if (!filePath) return new HttpResponse(404, 'not found');

    // Size + mtime is enough for a local file server and costs no read.
    const etag = `"${createHash('sha1')
      .update(`${info.size}-${info.mtimeMs}-${filePath}`)
      .digest('base64url')}"`;

    if (ctx.req.headers['if-none-match'] === etag) {
      ctx.res.writeHead(304, { etag });
      ctx.res.end();
      return undefined;
    }

    const type = contentTypeFor(filePath);
    const isHtml = type.startsWith('text/html');
    ctx.res.writeHead(200, {
      'content-type': type,
      'content-length': String(info.size),
      etag,
      'cache-control': isHtml ? 'no-cache' : cacheControl,
    });

    if (ctx.method === 'HEAD') {
      ctx.res.end();
      return undefined;
    }

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const stream = createReadStream(filePath!);
      stream.on('error', rejectPromise);
      stream.on('end', resolvePromise);
      stream.pipe(ctx.res);
    });
    return undefined;
  };
}
