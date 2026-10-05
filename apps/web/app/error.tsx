'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { Button, Container, Eyebrow, Input, RotateCcwIcon } from '../src/components/ui';

/**
 * Shown when a page fails to render. It never prints the error message or stack: those can
 * hold internal detail. The digest is an opaque id the operator can find in the server log.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // The content changed under the visitor's focus: move it to the heading so it is read out.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const digest = typeof error.digest === 'string' ? error.digest.slice(0, 64) : null;

  return (
    <div className="dot-grid border-border border-b">
      <Container width="reading" className="py-16 sm:py-24">
        <Eyebrow className="mb-4">Error</Eyebrow>
        <h1 ref={headingRef} tabIndex={-1} className="display-2 text-text outline-none">
          Something went <em>wrong</em>
        </h1>
        <p className="mt-4 max-w-xl text-body text-muted">
          The registry could not complete this request. Nothing was changed. Try again in a moment.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={reset} leadingIcon={<RotateCcwIcon size={15} />}>
            Try again
          </Button>
          <Button href="/" variant="secondary">
            Back to the registry
          </Button>
        </div>

        <search aria-label="Search skills" className="mt-10 block max-w-xl">
          <form action="/" method="get" className="flex flex-col gap-2 sm:flex-row">
            <label htmlFor="error-q" className="sr-only">
              Search skills
            </label>
            <Input
              id="error-q"
              name="q"
              type="search"
              maxLength={200}
              placeholder="Or search for a skill"
              autoComplete="off"
              className="sm:flex-1"
            />
            <Button type="submit" variant="ghost">
              Search
            </Button>
          </form>
        </search>

        {digest ? (
          <p className="mt-10 font-mono text-[0.75rem] text-subtle">
            Reference <span className="break-all text-muted">{digest}</span>
          </p>
        ) : null}
        <p className="mt-3 text-muted text-small">
          If it keeps happening, the <Link href="/guidelines#troubleshooting">troubleshooting</Link>{' '}
          notes may help.
        </p>
      </Container>
    </div>
  );
}
