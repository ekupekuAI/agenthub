'use client';

import { motion } from 'motion/react';
import { createContext, type ReactNode, useContext } from 'react';
import { usePrefersReducedMotion } from './hooks';

const TAGS = {
  div: motion.div,
  section: motion.section,
  article: motion.article,
  header: motion.header,
  ul: motion.ul,
  ol: motion.ol,
  li: motion.li,
  span: motion.span,
} as const;

export type RevealTag = keyof typeof TAGS;

const EASE_OUT = [0.25, 1, 0.5, 1] as const;
const DURATION = 0.4;
const RISE = 12;
const VIEWPORT = { once: true, margin: '0px 0px -10% 0px' } as const;

export interface RevealProps {
  children: ReactNode;
  /** Element to render. Default `div`. */
  as?: RevealTag;
  /** Seconds to wait after entering the viewport. */
  delay?: number;
  className?: string;
}

/**
 * Scroll-in: opacity 0 → 1 with a 12px rise over 400ms, once. Under prefers-reduced-motion
 * the content is shown in its final state straight away. Without JavaScript a <noscript>
 * rule in the root layout shows `[data-reveal]` elements.
 */
export function Reveal({ children, as = 'div', delay = 0, className }: RevealProps) {
  const reduced = usePrefersReducedMotion();
  const Tag = TAGS[as] as typeof motion.div;
  if (reduced) {
    return (
      <Tag
        data-reveal=""
        className={className}
        initial={{ opacity: 0, y: RISE }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0 }}
      >
        {children}
      </Tag>
    );
  }
  return (
    <Tag
      data-reveal=""
      className={className}
      initial={{ opacity: 0, y: RISE }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={VIEWPORT}
      transition={{ duration: DURATION, ease: EASE_OUT, delay }}
    >
      {children}
    </Tag>
  );
}

const StaggerReducedContext = createContext(false);

export interface StaggerProps {
  children: ReactNode;
  as?: RevealTag;
  /** Seconds between children. Default 0.06. */
  gap?: number;
  /** Seconds before the first child. */
  delay?: number;
  className?: string;
}

/** Reveals its <StaggerItem> children one after another (60ms apart) when scrolled into view. */
export function Stagger({ children, as = 'div', gap = 0.06, delay = 0, className }: StaggerProps) {
  const reduced = usePrefersReducedMotion();
  const Tag = TAGS[as] as typeof motion.div;
  const variants = {
    hidden: {},
    visible: {
      transition: reduced ? { duration: 0 } : { staggerChildren: gap, delayChildren: delay },
    },
  };
  return (
    <StaggerReducedContext.Provider value={reduced}>
      {reduced ? (
        <Tag className={className} variants={variants} initial="hidden" animate="visible">
          {children}
        </Tag>
      ) : (
        <Tag
          className={className}
          variants={variants}
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
        >
          {children}
        </Tag>
      )}
    </StaggerReducedContext.Provider>
  );
}

export interface StaggerItemProps {
  children: ReactNode;
  as?: RevealTag;
  className?: string;
}

/** A direct or nested child of <Stagger>. */
export function StaggerItem({ children, as = 'div', className }: StaggerItemProps) {
  const reduced = useContext(StaggerReducedContext);
  const Tag = TAGS[as] as typeof motion.div;
  return (
    <Tag
      data-reveal=""
      className={className}
      variants={{
        hidden: { opacity: 0, y: RISE },
        visible: {
          opacity: 1,
          y: 0,
          transition: reduced ? { duration: 0 } : { duration: DURATION, ease: EASE_OUT },
        },
      }}
    >
      {children}
    </Tag>
  );
}
