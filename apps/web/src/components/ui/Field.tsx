import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { TriangleAlertIcon } from './icons';

/** Ids of the helper and error text that belong to the control with this id. */
export function fieldIds(id: string): { hint: string; error: string } {
  return { hint: `${id}-hint`, error: `${id}-error` };
}

/** Value for `aria-describedby` on a control, given which texts its Field renders. */
export function describedBy(
  id: string,
  parts: { hint?: unknown; error?: unknown },
): string | undefined {
  const ids = fieldIds(id);
  const out = [parts.error ? ids.error : null, parts.hint ? ids.hint : null].filter(Boolean);
  return out.length > 0 ? out.join(' ') : undefined;
}

/** Shared look of text inputs, textareas and selects. */
export const CONTROL_CLASSES =
  'block w-full min-w-0 rounded-control border border-border-field bg-surface-1 px-3 text-body text-text transition-[border-color,background-color] duration-150 placeholder:text-subtle hover:border-subtle disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-block sm:text-small';

/** Props shared by TextField, TextareaField and SelectField. */
export interface ComposedFieldProps {
  /** Required: ties the label, the control and its helper texts together. */
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  /** Classes for the Field wrapper. */
  fieldClassName?: string;
}

export interface FieldProps {
  /** Id of the control inside. The label points at it; hint and error ids derive from it. */
  id: string;
  label: ReactNode;
  /** Helper text under the control. */
  hint?: ReactNode;
  /** Error text under the control. Rendered with role="alert". */
  error?: ReactNode;
  /** Adds "(optional)" after the label. */
  optional?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Label, control slot, helper text and error text. The control inside must use the same `id`
 * and `aria-describedby={describedBy(id, { hint, error })}`; TextField, TextareaField and
 * SelectField do that wiring for you.
 */
export function Field({ id, label, hint, error, optional, className, children }: FieldProps) {
  const ids = fieldIds(id);
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={id} className="font-medium text-small text-text">
        {label}
        {optional ? <span className="font-normal text-subtle"> (optional)</span> : null}
      </label>
      {children}
      {error ? (
        <p id={ids.error} role="alert" className="flex items-start gap-1.5 text-block text-small">
          <TriangleAlertIcon size={15} className="mt-[3px]" />
          <span>{error}</span>
        </p>
      ) : null}
      {hint ? (
        <p id={ids.hint} className="text-[0.8125rem] text-muted leading-5">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
