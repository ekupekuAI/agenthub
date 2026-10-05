'use client';

import { MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';

/** App-wide Motion settings: honor the visitor's reduced-motion preference. */
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
