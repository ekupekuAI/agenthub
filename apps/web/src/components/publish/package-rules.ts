import { formatBytes } from '../ui/format';

/*
 * Browser-side copies of the upload rules, so mistakes are caught before a 10 MiB upload
 * starts. The server action and the registry enforce the same rules again and stay
 * authoritative: MAX_UPLOAD_BYTES in src/config.ts (which imports node:path and cannot be
 * bundled for the browser), versionSchema and releaseNotesSchema in src/lib/validation.ts.
 */

/** A control of the publish form. The values are the ids and the names of the controls. */
export type PublishField = 'token' | 'file' | 'version' | 'releaseNotes';

export type PublishFieldErrors = Partial<Record<PublishField, string>>;

/** Document order, used to focus the first control that needs attention. */
export const PUBLISH_FIELDS: readonly PublishField[] = ['token', 'file', 'version', 'releaseNotes'];

export const MAX_PACKAGE_BYTES = 10 * 1024 * 1024;
export const MAX_RELEASE_NOTES = 5000;
export const PACKAGE_ACCEPT = '.skillpkg,application/gzip,application/octet-stream';

export const MESSAGES = {
  token: 'Enter your publisher token.',
  file: 'Choose a .skillpkg file to upload.',
  version: 'Use an exact version such as 1.2.0 or 1.3.0-beta.1.',
  releaseNotes: 'Release notes are limited to 5,000 characters.',
} as const;

/** An exact semver version without build metadata, as versionSchema requires. */
const EXACT_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

/** Why this file cannot be published, or undefined when it passes the browser-side checks. */
export function packageFileError(file: { name: string; size: number }): string | undefined {
  if (!/\.skillpkg$/i.test(file.name)) {
    return 'That file does not end in .skillpkg. Build a package with agenthub pack.';
  }
  if (file.size === 0) return 'That file is empty. Choose a .skillpkg file to upload.';
  if (file.size > MAX_PACKAGE_BYTES) {
    return `That file is ${formatBytes(file.size)}. Packages are limited to 10 MiB (${formatBytes(MAX_PACKAGE_BYTES)}).`;
  }
  return undefined;
}

/** Checks a publish submission in the browser. An empty result means it may be sent. */
export function validatePublishForm(
  data: FormData,
  opts: { requireToken?: boolean } = {},
): PublishFieldErrors {
  const errors: PublishFieldErrors = {};

  const token = data.get('token');
  if ((opts.requireToken ?? true) && (typeof token !== 'string' || token.trim() === '')) {
    errors.token = MESSAGES.token;
  }

  const file = data.get('file');
  if (!(file instanceof File) || (file.name === '' && file.size === 0)) {
    errors.file = MESSAGES.file;
  } else {
    const problem = packageFileError(file);
    if (problem) errors.file = problem;
  }

  const version = data.get('version');
  if (typeof version === 'string' && version.trim() !== '') {
    const value = version.trim();
    if (value.length > 128 || !EXACT_VERSION.test(value)) errors.version = MESSAGES.version;
  }

  const notes = data.get('releaseNotes');
  if (typeof notes === 'string' && notes.length > MAX_RELEASE_NOTES) {
    errors.releaseNotes = MESSAGES.releaseNotes;
  }

  return errors;
}
