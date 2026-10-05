import { requireAdminBearer } from '../../../../../../src/lib/auth';
import { apiRoute, jsonOk, readJson } from '../../../../../../src/lib/http';
import { getRegistry } from '../../../../../../src/lib/registry';
import { scanBodySchema, slugParamsSchema } from '../../../../../../src/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Seconds a serverless platform (Vercel) lets one call run: a cold start plus a full scan. */
export const maxDuration = 60;

/** POST /api/v1/skills/:slug/scan  { version } (admin) */
export const POST = apiRoute<{ slug: string }>('admin', async (request, params) => {
  requireAdminBearer(request);
  const { slug } = slugParamsSchema.parse(params);
  const { version } = scanBodySchema.parse(await readJson(request));
  const registry = await getRegistry();
  return jsonOk(await registry.rescan(slug, version));
});
