'use server';

import type { PublishField } from '../../src/components/publish/package-rules';
import { MAX_UPLOAD_BYTES } from '../../src/config';
import {
  currentPublisher,
  guardOrigin,
  limitFailedAttempt,
  limitIdentity,
} from '../../src/lib/action-guard';
import { isApiError } from '../../src/lib/errors';
import { getRegistry, type PublishSummary } from '../../src/lib/registry';
import { releaseNotesSchema, versionSchema } from '../../src/lib/validation';

export type PublishState =
  | { status: 'idle' }
  /** `field` names the control the message belongs to; without it the form shows an alert. */
  | { status: 'error'; message: string; field?: PublishField }
  | { status: 'done'; summary: PublishSummary };

export async function publishAction(
  _prev: PublishState,
  formData: FormData,
): Promise<PublishState> {
  const blocked = await guardOrigin();
  if (blocked) return { status: 'error', message: blocked };

  const token = formData.get('token');
  const file = formData.get('file');
  const notes = formData.get('releaseNotes');
  const versionField = formData.get('version');
  // Signed in with GitHub, the form has no token field: the session identifies the publisher.
  const usesToken = typeof token === 'string' && token.trim() !== '';
  const session = usesToken ? null : await currentPublisher();
  if (!usesToken && !session) {
    return { status: 'error', field: 'token', message: 'Enter your publisher token.' };
  }
  if (!(file instanceof File) || file.size === 0) {
    return { status: 'error', field: 'file', message: 'Choose a .skillpkg file to upload.' };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { status: 'error', field: 'file', message: 'Packages are limited to 10 MiB.' };
  }
  const releaseNotes = releaseNotesSchema.safeParse(
    typeof notes === 'string' && notes.trim() ? notes : undefined,
  );
  if (!releaseNotes.success) {
    return {
      status: 'error',
      field: 'releaseNotes',
      message:
        typeof notes === 'string' && notes.length > 5000
          ? 'Release notes are limited to 5,000 characters.'
          : 'Release notes must not contain control characters.',
    };
  }
  // Like `agenthub pack --version`: only for a package without agenthub.yaml. The registry
  // refuses a value that conflicts with the manifest.
  const versionInput = typeof versionField === 'string' ? versionField.trim() : '';
  const version = versionInput === '' ? undefined : versionSchema.safeParse(versionInput);
  if (version && !version.success) {
    return {
      status: 'error',
      field: 'version',
      message: 'Use an exact version such as 1.2.0 or 1.3.0-beta.1.',
    };
  }

  try {
    const registry = await getRegistry();
    const publisher = session
      ? session.publisher
      : await registry.authenticatePublisher(String(token).trim());
    if (!publisher) {
      const limited = await limitFailedAttempt();
      if (limited) return { status: 'error', message: limited };
      return { status: 'error', field: 'token', message: 'That publisher token is not valid.' };
    }
    // Limited per publisher, after the token verified: nobody can use up someone else's quota.
    const limited = limitIdentity('publish', `publisher:${publisher.id}`);
    if (limited) return { status: 'error', message: limited };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const summary = await registry.publish(bytes, publisher.id, {
      releaseNotes: releaseNotes.data,
      version: version?.data,
    });
    return { status: 'done', summary };
  } catch (error) {
    if (isApiError(error)) return { status: 'error', message: error.message };
    console.error('[agenthub] publish failed:', error instanceof Error ? error.message : error);
    return { status: 'error', message: 'Publishing failed because of a server error.' };
  }
}
