import { apiRoute, jsonOk } from '../../../../../../src/lib/http';
import { getRegistry } from '../../../../../../src/lib/registry';
import {
  paramsToObject,
  slugParamsSchema,
  versionsQuerySchema,
} from '../../../../../../src/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/skills/:slug/versions[?limit=&offset=] → versions newest first, including
 * quarantined and revoked ones (at most 1000 per page). Scans carry outcome and counts only;
 * findings are in GET /api/v1/skills/:slug for the latest version.
 */
export const GET = apiRoute<{ slug: string }>('read', async (request, params) => {
  const { slug } = slugParamsSchema.parse(params);
  const query = versionsQuerySchema.parse(paramsToObject(new URL(request.url).searchParams));
  const registry = await getRegistry();
  return jsonOk({ versions: await registry.listVersions(slug, query) });
});
