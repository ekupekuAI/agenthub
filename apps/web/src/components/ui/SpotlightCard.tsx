'use client';

import { motion, useMotionValue, useSpring } from 'motion/react';
import type { PointerEvent, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface SpotlightCardProps {
  children: ReactNode;
  /** Classes for the outer frame (grid placement, min-height). */
  className?: string;
  /** Classes for the surface that holds the content. Defaults to `p-5 sm:p-6`. */
  innerClassName?: string;
}

const SPRING = { stiffness: 300, damping: 26 };
const GLOW = 440;

/**
 * A card whose 1px border lights up under the cursor. The glow is a blurred disc moved with
 * transforms behind a 1px frame; it only exists for hover-capable fine pointers and is
 * decorative, so touch and keyboard users get a plain card.
 */
export function SpotlightCard({ children, className, innerClassName }: SpotlightCardProps) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const glowX = useSpring(x, SPRING);
  const glowY = useSpring(y, SPRING);

  function position(event: PointerEvent<HTMLDivElement>): [number, number] {
    const rect = event.currentTarget.getBoundingClientRect();
    return [event.clientX - rect.left - GLOW / 2, event.clientY - rect.top - GLOW / 2];
  }

  function onPointerEnter(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== 'mouse') return;
    const [px, py] = position(event);
    glowX.jump(px);
    glowY.jump(py);
    x.jump(px);
    y.jump(py);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== 'mouse') return;
    const [px, py] = position(event);
    x.set(px);
    y.set(py);
  }

  return (
    <div
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      className={cn(
        'spotlight relative isolate overflow-hidden rounded-card bg-border p-px',
        className,
      )}
    >
      <motion.div
        aria-hidden="true"
        className="spotlight-glow pointer-events-none absolute top-0 left-0 -z-10 rounded-full"
        style={{
          x: glowX,
          y: glowY,
          width: GLOW,
          height: GLOW,
          background: 'radial-gradient(circle, var(--signal-ink) 0%, transparent 62%)',
        }}
      />
      <div
        className={cn(
          'relative h-full overflow-hidden rounded-[13px] bg-surface-1',
          innerClassName ?? 'p-5 sm:p-6',
        )}
      >
        <motion.div
          aria-hidden="true"
          className="spotlight-glow pointer-events-none absolute top-0 left-0 rounded-full"
          style={{
            x: glowX,
            y: glowY,
            width: GLOW,
            height: GLOW,
            background:
              'radial-gradient(circle, color-mix(in oklab, var(--signal-ink) 9%, transparent) 0%, transparent 60%)',
          }}
        />
        <div className="relative h-full">{children}</div>
      </div>
    </div>
  );
}
