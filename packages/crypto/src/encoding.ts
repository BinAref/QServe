/** Base64url helpers. Signatures and keys travel as base64url everywhere. */

export const toBase64Url = (bytes: Uint8Array | Buffer): string =>
  Buffer.from(bytes).toString('base64url');

export const fromBase64Url = (text: string): Buffer => Buffer.from(text, 'base64url');

export const toHex = (bytes: Uint8Array | Buffer): string =>
  Buffer.from(bytes).toString('hex');
