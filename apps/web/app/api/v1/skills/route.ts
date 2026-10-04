import { apiRoute, jsonOk } from '../../../../src/lib/http';
import { getRegistry } from '../../../../src/lib/registry';
import { paramsToObject, searchQuerySchema } from '../../../../src/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/skills?q=&agent=&category=&limit= */
export const GET = apiRoute('read', async (request) => {
  const query = searchQuerySchema.parse(paramsToObject(new URL(request.url).searchParams));
  const registry = await getRegistry();
  const results = await registry.search(query);
  return jsonOk({ results });
});
