'use client';

import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { HEADING_IDS, sectionOf, TOC } from './toc';
import { useScrollSpy } from './useScrollSpy';

const EASE_OUT = [0.25, 1, 0.5, 1] as const;
const MARKER_HEIGHT = 20;

function pad(index: number): string {
  return String(index + 1).padStart(2, '0');
}

/**
 * The sticky table of contents shown from 1024px. The section being read is highlighted and
 * opens to list its subsections; a marker slides along the rail to the current entry.
 * Without JavaScript it is a plain list of the seven sections.
 */
export function TocNav({ className }: { className?: string }) {
  const activeId = useScrollSpy(HEADING_IDS);
  const activeSection = sectionOf(activeId);
  const listRef = useRef<HTMLOListElement | null>(null);
  const [markerY, setMarkerY] = useState<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeId changes which link is current
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const place = () => {
      const current = list.querySelector<HTMLElement>('[aria-current="location"]');
      if (!current) {
        setMarkerY(null);
        return;
      }
      const style = getComputedStyle(current);
      const top = current.getBoundingClientRect().top - list.getBoundingClientRect().top;
      const firstLine = Number.parseFloat(style.lineHeight) || MARKER_HEIGHT;
      const inset = Number.parseFloat(style.paddingTop) || 0;
      setMarkerY(Math.round(top + inset + (firstLine - MARKER_HEIGHT) / 2));
    };

    place();
    // Web fonts and a resized window change where the entries sit.
    const observer = new ResizeObserver(place);
    observer.observe(list);
    return () => observer.disconnect();
  }, [activeId]);

  return (
    <nav aria-labelledby="toc-heading" className={className}>
      <p id="toc-heading" className="eyebrow">
        On this page
      </p>
      <ol ref={listRef} className="relative m-0 mt-4 list-none border-border border-l p-0">
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute top-0 -left-px h-5 w-0.5 rounded-full bg-signal-ink"
          initial={false}
          animate={{ y: markerY ?? 0, opacity: markerY === null ? 0 : 1 }}
          transition={{ duration: 0.18, ease: EASE_OUT }}
        />
        {TOC.map((section, index) => {
          const open = activeSection?.id === section.id;
          return (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                aria-current={activeId === section.id ? 'location' : undefined}
                className={cn(
                  'flex items-baseline gap-2.5 py-1.5 pr-1 pl-4 text-small no-underline transition-colors duration-150 pointer-coarse:py-2.5',
                  open ? 'text-text' : 'text-muted hover:text-text',
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
              {open && section.children.length > 0 ? (
                <motion.ol
                  className="m-0 list-none p-0 pb-2"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.18, ease: EASE_OUT }}
                >
                  {section.children.map((child) => {
                    const current = activeId === child.id;
                    return (
                      <li key={child.id}>
                        <a
                          href={`#${child.id}`}
                          aria-current={current ? 'location' : undefined}
                          className={cn(
                            'block py-1 pr-1 pl-[2.875rem] text-[0.8125rem] leading-5 no-underline transition-colors duration-150 pointer-coarse:py-3',
                            current ? 'text-text' : 'text-subtle hover:text-text',
                          )}
                        >
                          {child.label}
                        </a>
                      </li>
                    );
                  })}
                </motion.ol>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
