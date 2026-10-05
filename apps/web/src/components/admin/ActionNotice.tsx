'use client';

import { motion } from 'motion/react';
import { type ReactNode, useEffect, useRef } from 'react';
import { cn } from '../../lib/cn';
import { Button, CircleCheckIcon, OctagonXIcon, XIcon } from '../ui';

export interface ActionNoticeProps {
  /** `success` reports a completed action; `danger` reports one that did not go through. */
  tone: 'success' | 'danger';
  title: ReactNode;
  children?: ReactNode;
  /** The same page without the result parameters. */
  dismissHref: string;
}

const TONES = {
  success: {
    frame: 'border-signal-line bg-signal-tint',
    accent: 'text-signal-ink',
    icon: <CircleCheckIcon size={18} />,
  },
  danger: {
    frame: 'border-block-line bg-block-tint',
    accent: 'text-block',
    icon: <OctagonXIcon size={18} />,
  },
} as const;

/**
 * The result of the last moderation action. The action ends in a redirect that remounts the
 * page, so keyboard focus would be lost: the notice takes it, which also scrolls the result
 * into view and has it read out.
 */
export function ActionNotice({ tone, title, children, dismissHref }: ActionNoticeProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { frame, accent, icon } = TONES[tone];

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <motion.div
      ref={ref}
      data-reveal=""
      tabIndex={-1}
      role={tone === 'danger' ? 'alert' : 'status'}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.25, 1, 0.5, 1] }}
      className={cn(
        'flex items-start gap-3 rounded-card border py-3 pr-3 pl-4 text-small text-text',
        frame,
      )}
    >
      <span className={cn('mt-1.5 shrink-0', accent)}>{icon}</span>
      <div className="min-w-0 flex-1 py-1.5">
        <p className={cn('font-semibold [overflow-wrap:anywhere]', accent)}>{title}</p>
        {children ? <p className="mt-0.5 text-text">{children}</p> : null}
      </div>
      <Button
        href={dismissHref}
        scroll={false}
        variant="ghost"
        size="sm"
        leadingIcon={<XIcon size={14} />}
      >
        Dismiss
      </Button>
    </motion.div>
  );
}
