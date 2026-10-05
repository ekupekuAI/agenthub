import { ZodError } from 'zod';
import { ApiError, isApiError } from './errors';
import { checkClientLimit, enforceDecision } from './rate-limit';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function jsonOk(
  data: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: init.status ?? 200,
    headers: { ...JSON_HEADERS, ...init.headers },
  });
}

export function jsonError(
  code: string,
  message: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

/** Map any thrown value to the JSON error envelope. Never leaks stack traces. */
export function errorResponse(error: unknown): Response {
  if (isApiError(error)) return jsonError(error.code, error.message, error.status, error.headers);
  if (error instanceof ZodError || (error instanceof Error && error.name === 'ZodError')) {
    const issue = (error as ZodError).issues?.[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    return jsonError('VALIDATION', `${where}${issue?.message ?? 'Invalid input'}`, 400);
  }
  console.error('[agenthub] unhandled error:', error instanceof Error ? error.message : error);
  return jsonError('INTERNAL', 'Internal server error.', 500);
}

/** The host the browser addressed (X-Forwarded-Host when present, else Host). */
export function requestHost(headers: Headers): string | null {
  return headers.get('x-forwarded-host')?.split(',')[0]?.trim() || headers.get('host');
}

/** True when an Origin header is present and names a different host. */
export function isCrossOrigin(headers: Headers): boolean {
  const origin = headers.get('origin');
  if (!origin) return false;
  const host = requestHost(headers);
  try {
    return !host || new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/** Strict check for browser form posts: an Origin header is required and must match. */
export function isSameOriginStrict(headers: Headers): boolean {
  const origin = headers.get('origin');
  if (!origin) return false;
  return !isCrossOrigin(headers);
}

/** Charge one anonymous request of the group; throws RATE_LIMITED when over the limit. */
export function enforceClientRateLimit(group: 'read' | 'page', headers: Headers): void {
  enforceDecision(checkClientLimit(group, headers));
}

type RouteContext<P> = { params: Promise<P> };

/**
 * Wrap a route handler: rate limit, reject cross-origin browser POSTs, map errors to JSON.
 * API callers authenticate with bearer tokens (no cookies), so an absent Origin is allowed.
 *
 * 'read' routes are anonymous and charged per client (see rate-limit.ts) before the handler
 * runs. 'publish' and 'admin' routes are charged per credential by the handler itself
 * (requireAdminBearer, requirePublisherBearer) once the credential verified; failed
 * credentials are charged to the client's 'auth' bucket. So nobody can lock a publisher or the
 * administrator out by sending requests in their name.
 */
export function apiRoute<P = Record<string, never>>(
  group: 'read' | 'publish' | 'admin',
  handler: (request: Request, params: P) => Promise<Response>,
) {
  return async (request: Request, context: RouteContext<P>): Promise<Response> => {
    try {
      if (group === 'read') enforceClientRateLimit('read', request.headers);
      if (request.method !== 'GET' && request.method !== 'HEAD' && isCrossOrigin(request.headers)) {
        throw new ApiError('FORBIDDEN', 'Cross-origin requests are not allowed.');
      }
      return await handler(request, await context.params);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** Parse a JSON request body with a size cap. */
export async function readJson(request: Request, maxBytes = 16 * 1024): Promise<unknown> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new ApiError('VALIDATION', 'Expected Content-Type: application/json.', { status: 415 });
  }
  const bytes = await readBody(request, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError('VALIDATION', 'The request body is not valid JSON.');
  }
}

/** Read a request body, refusing anything larger than maxBytes (checked while streaming). */
export async function readBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new ApiError('VALIDATION', 'The request body is too large.', { status: 413 });
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ApiError('VALIDATION', 'The request body is too large.', { status: 413 });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
