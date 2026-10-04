'use server';

import { MAX_UPLOAD_BYTES } from '../../src/config';
import { guardAction } from '../../src/lib/action-guard';
import { isApiError } from '../../src/lib/errors';
import { getRegistry, type PublishSummary } from '../../src/lib/registry';
import { releaseNotesSchema } from '../../src/lib/validation';

export type PublishState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'done'; summary: PublishSummary };

export async function publishAction(
  _prev: PublishState,
  formData: FormData,
): Promise<PublishState> {
  const blocked = await guardAction('publish');
  if (blocked) return { status: 'error', message: blocked };

  const token = formData.get('token');
  const file = formData.get('file');
  const notes = formData.get('releaseNotes');
  if (typeof token !== 'string' || token.trim() === '') {
    return { status: 'error', message: 'Enter your publisher token.' };
  }
  if (!(file instanceof File) || file.size === 0) {
    return { status: 'error', message: 'Choose a .skillpkg file to upload.' };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { status: 'error', message: 'Packages are limited to 10 MiB.' };
  }
  const releaseNotes = releaseNotesSchema.safeParse(
    typeof notes === 'string' && notes.trim() ? notes : undefined,
  );
  if (!releaseNotes.success) {
    return { status: 'error', message: 'Release notes are limited to 5,000 characters.' };
  }

  try {
    const registry = await getRegistry();
    const publisher = await registry.authenticatePublisher(token.trim());
    if (!publisher) return { status: 'error', message: 'That publisher token is not valid.' };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const summary = await registry.publish(bytes, publisher.id, {
      releaseNotes: releaseNotes.data,
    });
    return { status: 'done', summary };
  } catch (error) {
    if (isApiError(error)) return { status: 'error', message: error.message };
    console.error('[agenthub] publish failed:', error instanceof Error ? error.message : error);
    return { status: 'error', message: 'Publishing failed because of a server error.' };
  }
}
