'use client';

import { type ReactNode, useId } from 'react';
import { cn } from '../../lib/cn';
import { XIcon } from './icons';
import { Modal } from './Modal';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** One or two sentences that say what will happen. */
  description?: ReactNode;
  /** Body: usually a form with a required reason field. */
  children?: ReactNode;
  /** Action row, right-aligned on desktop and stacked on mobile. Put the safe action first. */
  footer?: ReactNode;
  /** `danger` tints the title for destructive confirmations. */
  tone?: 'default' | 'danger';
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Modal confirmation dialog. Focus is trapped inside and returns to the trigger on close;
 * Esc, the close button and the scrim all call `onClose`. Mark the field that should receive
 * focus with `data-autofocus`; otherwise the first focusable element gets it.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  tone = 'default',
  size = 'md',
  className,
}: DialogProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      describedBy={description ? descriptionId : undefined}
      placement="center"
      className={cn(
        'flex max-h-[min(90dvh,44rem)] w-full flex-col rounded-t-panel border border-border-strong bg-surface-1 shadow-pop sm:rounded-panel',
        size === 'sm' ? 'sm:max-w-md' : 'sm:max-w-lg',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4 px-5 pt-5 sm:px-6 sm:pt-6">
        <div className="min-w-0">
          <h2
            id={titleId}
            className={cn(
              'font-semibold text-[1.125rem] leading-7',
              tone === 'danger' ? 'text-block' : 'text-text',
            )}
          >
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="mt-1 text-muted text-small">
              {description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="hit-area -mt-1 -mr-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-chip text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
        >
          <XIcon size={18} />
          <span className="sr-only">Close dialog</span>
        </button>
      </div>
      {children ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">{children}</div>
      ) : null}
      {footer ? (
        <div className="flex flex-col-reverse gap-2 border-border border-t px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
          {footer}
        </div>
      ) : (
        <div className="h-2" />
      )}
    </Modal>
  );
}
