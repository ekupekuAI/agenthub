import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRightIcon,
  Button,
  Container,
  Eyebrow,
  Input,
  ReceiptRow,
} from '../src/components/ui';

export const metadata: Metadata = {
  title: 'Not found',
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <div className="dot-grid border-border border-b">
      <Container width="reading" className="py-16 sm:py-24">
        <Eyebrow className="mb-4">404 · Not found</Eyebrow>
        <h1 className="display-2 text-text [text-wrap:balance]">
          Nothing is <em>listed</em> at this address
        </h1>
        <p className="mt-4 max-w-xl text-body text-muted">
          There is no page or skill here. Skill names are lowercase with hyphens, for example{' '}
          <code className="font-mono text-mono text-text">web-testing</code>.
        </p>

        <search aria-label="Search skills" className="mt-8 block max-w-xl">
          <form action="/" method="get" className="flex flex-col gap-2 sm:flex-row">
            <label htmlFor="not-found-q" className="sr-only">
              Search skills
            </label>
            <Input
              id="not-found-q"
              name="q"
              type="search"
              maxLength={200}
              placeholder="Search by name or task, e.g. web testing"
              autoComplete="off"
              className="sm:flex-1"
            />
            <Button type="submit" variant="primary">
              Search
            </Button>
          </form>
        </search>

        <dl className="m-0 mt-10 max-w-xl rounded-card border border-border bg-surface-1 px-4 py-2 shadow-panel">
          <ReceiptRow label="status">404</ReceiptRow>
          <ReceiptRow label="skills matched">0</ReceiptRow>
          <ReceiptRow label="files written">0</ReceiptRow>
        </dl>

        <p className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-small">
          <Link href="/" className="inline-flex items-center gap-1.5 font-medium">
            Back to the registry <ArrowRightIcon size={14} />
          </Link>
          <Link href="/guidelines" className="text-muted hover:text-text">
            Read the guidelines
          </Link>
        </p>
      </Container>
    </div>
  );
}
