/**
 * Domain errors.
 *
 * Every failure that crosses the HTTP boundary carries a stable `code` and a
 * translation key. The server never sends prose to a terminal: the terminal
 * renders the message in the diner's or the cook's own language.
 */

export interface AppErrorOptions {
  readonly status?: number;
  readonly messageKey?: string;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly messageKey: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? 400;
    this.messageKey = options.messageKey ?? `error.${code.toLowerCase()}`;
    this.details = options.details ?? {};
  }

  toJSON(): Record<string, unknown> {
    return {
      error: { code: this.code, messageKey: this.messageKey, details: this.details },
    };
  }
}

export const ErrorCode = {
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  /** The action needs a capability that SETUP mode does not grant (spec §2). */
  LICENSE_REQUIRED: 'LICENSE_REQUIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
  UNSUPPORTED: 'UNSUPPORTED',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const validationError = (detail: string, details?: Record<string, unknown>): AppError =>
  new AppError(ErrorCode.VALIDATION, detail, {
    status: 400,
    messageKey: 'error.validation',
    ...(details ? { details } : {}),
  });

export const notFound = (what: string, id?: string): AppError =>
  new AppError(ErrorCode.NOT_FOUND, `${what} not found${id ? `: ${id}` : ''}`, {
    status: 404,
    messageKey: 'error.not_found',
    details: { resource: what, ...(id ? { id } : {}) },
  });

export const conflict = (detail: string, details?: Record<string, unknown>): AppError =>
  new AppError(ErrorCode.CONFLICT, detail, {
    status: 409,
    messageKey: 'error.conflict',
    ...(details ? { details } : {}),
  });

export const unauthenticated = (detail = 'authentication required'): AppError =>
  new AppError(ErrorCode.UNAUTHENTICATED, detail, {
    status: 401,
    messageKey: 'error.unauthenticated',
  });

export const forbidden = (permission?: string): AppError =>
  new AppError(ErrorCode.FORBIDDEN, `permission denied${permission ? `: ${permission}` : ''}`, {
    status: 403,
    messageKey: 'error.forbidden',
    ...(permission ? { details: { permission } } : {}),
  });

/** Raised by the license gate. The UI turns this into the "activate" prompt. */
export const licenseRequired = (capability: string): AppError =>
  new AppError(ErrorCode.LICENSE_REQUIRED, `capability requires an active license: ${capability}`, {
    status: 402,
    messageKey: 'error.license_required',
    details: { capability },
  });
