import { requireAdminBearer } from '../../../../../../src/lib/auth';
import { apiRoute, jsonOk, readJson } from '../../../../../../src/lib/http';
import { getRegistry } from '../../../../../../src/lib/registry';
import { managePublisherSchema } from '../../../../../../src/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/admin/publishers/manage  { displayName, action } (admin)
 * - 'rotate-token': issue a new token (shown once); the old one stops working.
 * - 'disable' / 'enable': suspend or reinstate the publisher; a suspended token is refused.
 */
export const POST = apiRoute('admin', async (request) => {
  requireAdminBearer(request);
  const { displayName, action } = managePublisherSchema.parse(await readJson(request));
  const registry = await getRegistry();
  if (action === 'rotate-token') return jsonOk(await registry.rotatePublisherToken(displayName));
  return jsonOk(await registry.setPublisherDisabled(displayName, action === 'disable'));
});
