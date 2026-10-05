'use client';

import { useEffect, useState } from 'react';

/** How far below its resting position a heading may be and already count as current. */
const SLACK = 16;

/**
 * Scrollspy: the id of the last heading that has reached the reading line, or null above the
 * first one. The reading line is where an in-page link puts a heading (the document's
 * scroll padding plus the heading's scroll margin), so following a link always selects its
 * target. `ids` must be a stable array in document order.
 */
export function useScrollSpy(ids: readonly string[]): string | null {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const headings: HTMLElement[] = [];
    for (const id of ids) {
      const element = document.getElementById(id);
      if (element) headings.push(element);
    }
    const first = headings[0];
    const last = headings[headings.length - 1];
    if (!first || !last) return;

    let frame = 0;
    let line = 0;

    const measure = () => {
      const padding = Number.parseFloat(
        getComputedStyle(document.documentElement).scrollPaddingTop,
      );
      const margin = Number.parseFloat(getComputedStyle(first).scrollMarginTop);
      line = (Number.isFinite(padding) ? padding : 0) + (Number.isFinite(margin) ? margin : 0);
    };

    const update = () => {
      frame = 0;
      const root = document.documentElement;
      const atEnd =
        window.scrollY > 0 &&
        Math.ceil(window.innerHeight + window.scrollY) >= root.scrollHeight - 1;
      let current: string | null = null;
      if (atEnd) {
        // The last headings can never reach the line: the page runs out first.
        current = last.id;
      } else {
        for (const heading of headings) {
          if (heading.getBoundingClientRect().top > line + SLACK) break;
          current = heading.id;
        }
      }
      setActive(current);
    };

    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };

    const onResize = () => {
      measure();
      schedule();
    };

    measure();
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', onResize);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [ids]);

  return active;
}
