'use client';

import { type ReactNode, useEffect, useRef } from 'react';
import { cn } from '../../lib/cn';

/** Space kept above (under the site header) and below the rail, in rem. */
const GAP_REM = 1.5;

function headerHeight(rem: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--header-h').trim();
  const value = Number.parseFloat(raw);
  if (Number.isNaN(value)) return 3.5 * rem;
  return raw.endsWith('rem') ? value * rem : value;
}

export interface StickyRailProps {
  className?: string;
  children: ReactNode;
}

/**
 * The side rail of the skill page. From 1024px it is a sticky column. When the rail is
 * taller than the viewport its `top` goes negative, so it scrolls with the page until its
 * last panel is in view and only then sticks; nothing in it is ever out of reach.
 *
 * Under 1024px the wrapper is `display: contents`: its children join the parent grid and
 * are placed with `order`, which is how the receipt lands above the README on small screens.
 */
export function StickyRail({ className, children }: StickyRailProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const rail = ref.current;
    if (!rail) return;
    const update = () => {
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const gap = GAP_REM * rem;
      const underHeader = headerHeight(rem) + gap;
      const bottomAligned = window.innerHeight - rail.offsetHeight - gap;
      rail.style.setProperty('--rail-top', `${Math.round(Math.min(underHeader, bottomAligned))}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(rail);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={cn(
        'contents lg:sticky lg:top-[var(--rail-top,calc(var(--header-h)+1.5rem))] lg:flex lg:min-w-0 lg:flex-col lg:gap-6',
        className,
      )}
    >
      {children}
    </div>
  );
}
