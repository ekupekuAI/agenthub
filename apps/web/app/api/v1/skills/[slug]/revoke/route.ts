import { requireAdminBearer } from '../../../../../../src/lib/auth';
import { apiRoute, jsonOk, readJson } from '../../../../../../src/lib/http';
import { getRegistry } from '../../../../../../src/lib/registry';
import { revokeBodySchema, slugParamsSchema } from '../../../../../../src/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/v1/skills/:slug/revoke  { version, reason } (admin) */
export const POST = apiRoute<{ slug: string }>('admin', async (request, params) => {
  requireAdminBearer(request);
  const { slug } = slugParamsSchema.parse(params);
  const { version, reason } = revokeBodySchema.parse(await readJson(request));
  const registry = await getRegistry();
  return jsonOk(await registry.revoke(slug, version, reason));
});
