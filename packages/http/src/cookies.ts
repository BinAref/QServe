/** Cookie parsing and serialisation. Sessions ride on these. */

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      out[name] = part.slice(index + 1).trim();
    }
  }
  return out;
}

export interface CookieOptions {
  readonly maxAgeSeconds?: number;
  readonly path?: string;
  readonly httpOnly?: boolean;
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
  /**
   * Left false by default and documented as such: a restaurant LAN is plain
   * HTTP, and marking session cookies Secure there would silently drop them.
   * See docs/SECURITY.md for the threat model this accepts.
   */
  readonly secure?: boolean;
}

export function serialiseCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export const expiredCookie = (name: string, path = '/'): string =>
  `${name}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Lax`;
