'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { ChevronDownIcon } from '../ui';
import { HEADING_IDS, sectionOf, TOC } from './toc';
import { useScrollSpy } from './useScrollSpy';

function pad(index: number): string {
  return String(index + 1).padStart(2, '0');
}

/**
 * "On this page" under 1024px: a slim bar that sticks under the site header and names the
 * section being read. It is a native disclosure, so it opens without JavaScript too.
 * Escape, choosing a section or tapping outside closes it.
 */
export function TocMobile({ className }: { className?: string }) {
  const activeId = useScrollSpy(HEADING_IDS);
  const current = sectionOf(activeId);
  const currentIndex = current ? TOC.findIndex((section) => section.id === current.id) : -1;
  const [open, setOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      detailsRef.current?.querySelector('summary')?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!detailsRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <nav
      aria-label="On this page"
      className={cn(
        'sticky top-(--header-h) z-30 -mx-4 border-border border-b bg-bg/95 backdrop-blur-md supports-[backdrop-filter]:bg-bg/85 sm:-mx-6',
        className,
      )}
    >
      <details
        ref={detailsRef}
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
        className="group relative"
      >
        <summary className="flex h-12 cursor-pointer list-none items-center gap-3 px-4 sm:px-6 [&::-webkit-details-marker]:hidden">
          <span className="eyebrow shrink-0">On this page</span>
          <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-border-strong" />
          <span className="min-w-0 flex-1 truncate text-small text-text">
            {current ? (
              <>
                <span aria-hidden="true" className="mr-1.5 font-mono text-[0.75rem] text-subtle">
                  {pad(currentIndex)}
                </span>
                {current.label}
              </>
            ) : (
              <span className="text-muted">Seven sections</span>
            )}
          </span>
          <ChevronDownIcon
            size={16}
            className="shrink-0 text-muted transition-transform duration-150 group-open:rotate-180"
          />
        </summary>

        <div className="absolute inset-x-0 top-full max-h-[min(70vh,28rem)] overflow-y-auto border-border border-b bg-surface-1 shadow-pop">
          <ol className="m-0 list-none px-2 py-2 sm:px-4">
            {TOC.map((section, index) => {
              const isCurrent = current?.id === section.id;
              return (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    onClick={() => setOpen(false)}
                    aria-current={isCurrent ? 'location' : undefined}
                    className={cn(
                      'flex min-h-11 items-center gap-3 rounded-control px-2 text-small no-underline transition-colors duration-150',
                      isCurrent
                        ? 'bg-surface-2 text-text'
                        : 'text-muted hover:bg-surface-2 hover:text-text',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="w-5 shrink-0 font-mono text-[0.75rem] text-subtle tabular-nums"
                    >
                      {pad(index)}
                    </span>
                    <span className="min-w-0">{section.label}</span>
                  </a>
                </li>
              );
            })}
          </ol>
        </div>
      </details>
    </nav>
  );
}
