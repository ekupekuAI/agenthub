import { apiRoute } from '../../../../../../../src/lib/http';
import { getRegistry } from '../../../../../../../src/lib/registry';
import { agentSchema, downloadParamsSchema } from '../../../../../../../src/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHUNK_BYTES = 256 * 1024;

/**
 * The verified package bytes as a stream. Serverless platforms cap buffered response bodies
 * (Vercel: 4.5 MB) but not streamed ones, and packages may be up to 10 MiB.
 */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + CHUNK_BYTES, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

/** GET /api/v1/skills/:slug/download/:version → raw .skillpkg bytes. */
export const GET = apiRoute<{ slug: string; version: string }>('read', async (request, params) => {
  const { slug, version } = downloadParamsSchema.parse(params);
  const agentParam = new URL(request.url).searchParams.get('agent');
  const agent = agentParam ? agentSchema.parse(agentParam) : undefined;
  const registry = await getRegistry();
  const pkg = await registry.download(slug, version, { agent });
  return new Response(streamOf(pkg.bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.agenthub.skillpkg',
      'Content-Disposition': `attachment; filename="${pkg.filename}"`,
      'Content-Length': String(pkg.bytes.byteLength),
      'X-Content-Type-Options': 'nosniff',
      'X-Archive-Digest': pkg.archiveDigest,
      'X-Content-Digest': pkg.digest,
      'Cache-Control': 'no-store',
    },
  });
});
