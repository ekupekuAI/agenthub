import { apiRoute, jsonOk } from '../../../../../src/lib/http';
import { getRegistry } from '../../../../../src/lib/registry';
import { slugParamsSchema } from '../../../../../src/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/skills/:slug → SkillInfo */
export const GET = apiRoute<{ slug: string }>('read', async (_request, params) => {
  const { slug } = slugParamsSchema.parse(params);
  const registry = await getRegistry();
  return jsonOk(await registry.getSkillInfo(slug));
});
