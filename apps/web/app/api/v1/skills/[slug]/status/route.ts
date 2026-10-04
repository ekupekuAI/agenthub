import { requireAdminBearer } from '../../../../../../src/lib/auth';
import { apiRoute, jsonOk, readJson } from '../../../../../../src/lib/http';
import { getRegistry } from '../../../../../../src/lib/registry';
import { slugParamsSchema, statusBodySchema } from '../../../../../../src/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/v1/skills/:slug/status  { version, status, reason } (admin approve/quarantine) */
export const POST = apiRoute<{ slug: string }>('admin', async (request, params) => {
  requireAdminBearer(request);
  const { slug } = slugParamsSchema.parse(params);
  const { version, status, reason } = statusBodySchema.parse(await readJson(request));
  const registry = await getRegistry();
  return jsonOk(await registry.setStatus(slug, version, status, reason));
});
