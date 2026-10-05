'use client';

import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { useFocusTrap, useIsClient, useScrollLock } from './hooks';

export type ModalPlacement = 'center' | 'top' | 'right';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Id of the element that titles the dialog. Provide this or `label`. */
  labelledBy?: string;
  /** Accessible name when there is no visible title. */
  label?: string;
  describedBy?: string;
  /** `center` for dialogs, `top` for the command palette, `right` for the mobile sheet. */
  placement?: ModalPlacement;
  /** Classes for the panel (size, surface, radius). */
  className?: string;
  /** Clicking the scrim closes the modal. Default true. */
  closeOnScrim?: boolean;
  children: ReactNode;
}

const ENTER = { duration: 0.18, ease: [0.25, 1, 0.5, 1] as const };
/** Exits run 30% faster than enters. */
const EXIT = { duration: 0.126, ease: [0.4, 0, 1, 1] as const };

const LAYOUT: Record<ModalPlacement, string> = {
  center: 'items-end justify-center p-0 sm:items-center sm:p-6',
  top: 'items-start justify-center px-3 pt-[10vh] sm:px-6 sm:pt-[14vh]',
  right: 'items-stretch justify-end',
};

function ModalLayer({
  onClose,
  labelledBy,
  label,
  describedBy,
  placement = 'center',
  className,
  closeOnScrim = true,
  children,
}: Omit<ModalProps, 'open'>) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(panelRef, true);
  useScrollLock(true);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const hidden = placement === 'right' ? { opacity: 1, x: '100%' } : { opacity: 0, scale: 0.98 };
  const shown = placement === 'right' ? { opacity: 1, x: 0 } : { opacity: 1, scale: 1 };

  return (
    <div className={cn('fixed inset-0 z-50 flex', LAYOUT[placement])}>
      <motion.button
        type="button"
        tabIndex={-1}
        aria-label="Close"
        onClick={closeOnScrim ? onClose : undefined}
        className="absolute inset-0 size-full cursor-default bg-scrim backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: ENTER }}
        exit={{ opacity: 0, transition: EXIT }}
      />
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={cn('relative outline-none', className)}
        initial={hidden}
        animate={{ ...shown, transition: ENTER }}
        exit={{ ...hidden, transition: EXIT }}
      >
        {children}
      </motion.div>
    </div>
  );
}

/**
 * Base for every overlay (Dialog, CommandPalette, mobile sheet): portal to <body>, scrim,
 * role="dialog" + aria-modal, focus trap with focus restore, Esc to close, scroll lock, and a
 * 180ms scale/fade (or slide for `right`). Children mount only while open.
 */
export function Modal({ open, ...rest }: ModalProps) {
  const isClient = useIsClient();
  if (!isClient) return null;
  return createPortal(
    <AnimatePresence>{open ? <ModalLayer key="modal" {...rest} /> : null}</AnimatePresence>,
    document.body,
  );
}
