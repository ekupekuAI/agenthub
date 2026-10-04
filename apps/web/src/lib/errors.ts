/** Error codes shared with the CLI contract (packages/core/src/engine/api.ts consumers). */
export type ApiErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'GONE'
  | 'RATE_LIMITED'
  | 'INTEGRITY'
  | 'INTERNAL'
  /** Admin endpoints only: admin is not configured on this registry. */
  | 'UNAVAILABLE';

const STATUS: Record<ApiErrorCode, number> = {
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  GONE: 410,
  RATE_LIMITED: 429,
  INTEGRITY: 422,
  INTERNAL: 500,
  UNAVAILABLE: 503,
};

const BRAND = Symbol.for('agenthub.ApiError');

export class ApiError extends Error {
  readonly [BRAND] = true;
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly headers?: Record<string, string>;

  constructor(
    code: ApiErrorCode,
    message: string,
    opts: { status?: number; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = opts.status ?? STATUS[code];
    this.headers = opts.headers;
  }
}

/** Brand check: works even when Next.js bundles this module more than once. */
export function isApiError(error: unknown): error is ApiError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Record<symbol, unknown>)[BRAND] === true
  );
}
