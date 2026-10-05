import type { Metadata } from 'next';
import Link from 'next/link';
import { PublishSteps } from '../../src/components/publish/PublishSteps';
import { Callout, Container, PageHeader } from '../../src/components/ui';
import { PublishForm } from './PublishForm';

export const metadata: Metadata = {
  title: 'Publish a skill',
  description: 'Upload a .skillpkg package. Every version is immutable and scanned on upload.',
};

export default function PublishPage() {
  return (
    <>
      <PageHeader
        eyebrow="Publish"
        title={
          <>
            Ship a <em>scanned</em> version
          </>
        }
        lede="Upload a package built with agenthub pack. The registry recomputes both digests, stores the archive under its SHA-256 and scans every file before the version can be installed."
      />

      <Container className="py-10 lg:py-16">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,34rem)] lg:gap-16">
          <div className="flex min-w-0 flex-col gap-10">
            <section aria-labelledby="how-publishing-works">
              <p className="eyebrow">How it works</p>
              <h2
                id="how-publishing-works"
                className="mt-2 mb-8 font-display text-[1.75rem] text-text leading-[1.15]"
              >
                From folder to receipt
              </h2>
              <PublishSteps />
            </section>

            <Callout tone="note" title="The rules">
              <ul className="m-0 mt-1 grid list-none gap-2.5 p-0">
                <li>
                  <strong>Versions are immutable.</strong> You cannot replace <code>1.2.0</code>.
                  Publish <code>1.2.1</code> instead.
                </li>
                <li>
                  <strong>Every upload is scanned.</strong> A BLOCK finding quarantines the version
                  until a moderator reviews it.
                </li>
                <li>
                  <strong>Names belong to their first publisher.</strong> Read the{' '}
                  <Link href="/guidelines#publishing-rules">publishing rules</Link> first.
                </li>
              </ul>
            </Callout>

            <p className="text-muted text-small">
              Prefer the command line? Send <code>POST /api/v1/publish</code> with{' '}
              <code>Authorization: Bearer &lt;token&gt;</code> and the package bytes.
            </p>
          </div>

          <div className="min-w-0">
            <PublishForm />
          </div>
        </div>
      </Container>
    </>
  );
}
