import { requireAdminBearer } from '../../../../../src/lib/auth';
import { apiRoute, jsonOk, readJson } from '../../../../../src/lib/http';
import { getRegistry } from '../../../../../src/lib/registry';
import { createPublisherSchema } from '../../../../../src/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/publishers  { displayName, verified } → token (shown once). */
export const POST = apiRoute('admin', async (request) => {
  requireAdminBearer(request);
  const { displayName, verified } = createPublisherSchema.parse(await readJson(request));
  const registry = await getRegistry();
  const created = await registry.createPublisher(displayName, verified);
  return jsonOk(created, { status: 201 });
});
