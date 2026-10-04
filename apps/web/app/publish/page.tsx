import type { Metadata } from 'next';
import Link from 'next/link';
import { PublishForm } from './PublishForm';

export const metadata: Metadata = {
  title: 'Publish a skill',
  description: 'Upload a .skillpkg package. Every version is immutable and scanned on upload.',
};

export default function PublishPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">Publish a skill</h1>
      <div className="mt-3 max-w-3xl space-y-2 text-muted">
        <p>
          Upload a package built with <code>agenthub pack</code>. The registry recomputes both
          digests, stores the archive under its SHA-256, and scans every file before the version
          becomes installable.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            <strong className="text-ink">Versions are immutable.</strong> You cannot replace{' '}
            <code>1.2.0</code>; publish <code>1.2.1</code> instead.
          </li>
          <li>
            <strong className="text-ink">Every upload is scanned.</strong> A BLOCK finding
            quarantines the version until a moderator reviews it.
          </li>
          <li>
            <strong className="text-ink">Names belong to their first publisher.</strong> Read the{' '}
            <Link href="/guidelines#publishing-rules">publishing rules</Link> first.
          </li>
        </ul>
        <p className="text-sm">
          Prefer the command line? <code>POST /api/v1/publish</code> with{' '}
          <code>Authorization: Bearer &lt;token&gt;</code> and the package bytes.
        </p>
      </div>
      <div className="mt-8">
        <PublishForm />
      </div>
    </div>
  );
}
