import { MAX_UPLOAD_BYTES } from '../../../../src/config';
import { bearerToken } from '../../../../src/lib/auth';
import { ApiError } from '../../../../src/lib/errors';
import { apiRoute, jsonOk, readBody } from '../../../../src/lib/http';
import {
  checkIdentityLimit,
  enforceAuthFailureLimit,
  enforceDecision,
} from '../../../../src/lib/rate-limit';
import { getRegistry } from '../../../../src/lib/registry';
import { releaseNotesSchema, versionSchema } from '../../../../src/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MULTIPART_OVERHEAD = 64 * 1024;

/**
 * POST /api/v1/publish
 * Authorization: Bearer <publisher token>
 * Body: raw application/octet-stream bytes (?releaseNotes= and ?version= optional), or
 *       multipart/form-data with field `file` (and optional `releaseNotes`, `version`).
 * `version` is only for packages without agenthub.yaml; it must match the manifest otherwise.
 */
export const POST = apiRoute('publish', async (request) => {
  const registry = await getRegistry();
  const publisher = await registry.authenticatePublisher(
    bearerToken(request.headers.get('authorization')),
  );
  if (!publisher) {
    enforceAuthFailureLimit(request.headers);
    throw new ApiError('UNAUTHORIZED', 'A valid publisher token is required.', {
      headers: { 'WWW-Authenticate': 'Bearer' },
    });
  }

  // Charged per publisher once the token verified (before the body is read), so nobody can
  // exhaust a publisher's quota without holding its token.
  enforceDecision(checkIdentityLimit('publish', `publisher:${publisher.id}`));

  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  let bytes: Uint8Array;
  let notes: string | undefined;
  let versionParam: string | undefined;
  if (type.startsWith('application/octet-stream')) {
    bytes = await readBody(request, MAX_UPLOAD_BYTES);
    const params = new URL(request.url).searchParams;
    notes = params.get('releaseNotes') ?? undefined;
    versionParam = params.get('version') ?? undefined;
  } else if (type.startsWith('multipart/form-data')) {
    const raw = await readBody(request, MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD);
    let form: FormData;
    try {
      form = await new Response(Buffer.from(raw), {
        headers: { 'content-type': request.headers.get('content-type') ?? type },
      }).formData();
    } catch {
      throw new ApiError('VALIDATION', 'Malformed multipart body.');
    }
    const file = form.get('file');
    if (!(file instanceof Blob)) {
      throw new ApiError('VALIDATION', 'Missing multipart field "file".');
    }
    bytes = new Uint8Array(await file.arrayBuffer());
    const field = form.get('releaseNotes');
    notes = typeof field === 'string' ? field : undefined;
    const versionField = form.get('version');
    versionParam = typeof versionField === 'string' && versionField ? versionField : undefined;
  } else {
    throw new ApiError(
      'VALIDATION',
      'Send the package as application/octet-stream or multipart/form-data.',
      { status: 415 },
    );
  }

  const releaseNotes = releaseNotesSchema.parse(notes);
  const version = versionParam === undefined ? undefined : versionSchema.parse(versionParam);
  const summary = await registry.publish(bytes, publisher.id, { releaseNotes, version });
  return jsonOk(summary, { status: 201 });
});
