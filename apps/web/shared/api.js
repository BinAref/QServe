/**
 * Thin API client.
 *
 * Two jobs beyond `fetch`: it turns the server's `{ error: { code, messageKey } }`
 * envelope into a thrown `ApiError` carrying a translation key, and it detects
 * the "you need a licence" reply so the UI can show the activation prompt
 * instead of a generic failure.
 */

export class ApiError extends Error {
  constructor(status, code, messageKey, details) {
    super(`${code}: ${messageKey}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.messageKey = messageKey;
    this.details = details ?? {};
  }

  /** The action needs an active licence (HTTP 402). */
  get isLicenseRequired() {
    return this.code === 'LICENSE_REQUIRED';
  }

  get isUnauthenticated() {
    return this.status === 401;
  }
}

async function request(method, path, body, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined
        ? {}
        : { 'content-type': options.contentType ?? 'application/json' },
      body: body === undefined
        ? undefined
        : (options.raw ? body : JSON.stringify(body)),
      credentials: 'same-origin',
    });
  } catch (cause) {
    // The restaurant PC is on the same Wi-Fi; a failure here almost always means
    // the device wandered out of range rather than that the server is down.
    throw new ApiError(0, 'NETWORK', 'error.network', { cause: String(cause) });
  }

  if (response.status === 204) return null;

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? `HTTP_${response.status}`,
      error.messageKey ?? 'error.internal',
      error.details,
    );
  }
  return payload;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  put: (path, body) => request('PUT', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body ?? {}),
  del: (path) => request('DELETE', path),
  /** Binary upload: images and backup files. */
  upload: (path, bytes, contentType) =>
    request('POST', path, bytes, { raw: true, contentType }),
  raw: request,
};
