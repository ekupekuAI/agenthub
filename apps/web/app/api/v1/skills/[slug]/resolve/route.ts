import { apiRoute, jsonOk } from '../../../../../../src/lib/http';
import { getRegistry } from '../../../../../../src/lib/registry';
import {
  paramsToObject,
  resolveQuerySchema,
  slugParamsSchema,
} from '../../../../../../src/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/skills/:slug/resolve?agent=&version=&channel= */
export const GET = apiRoute<{ slug: string }>('read', async (request, params) => {
  const { slug } = slugParamsSchema.parse(params);
  const query = resolveQuerySchema.parse(paramsToObject(new URL(request.url).searchParams));
  const registry = await getRegistry();
  return jsonOk(
    await registry.resolve(slug, {
      agent: query.agent,
      range: query.version,
      channel: query.channel,
    }),
  );
});
