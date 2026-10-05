import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  id: string;
  label: ReactNode;
  /** Classes for the wrapping label. */
  wrapperClassName?: string;
}

/** Native checkbox with a visible label and a 44px row on touch screens. */
export function Checkbox({ id, label, className, wrapperClassName, ...rest }: CheckboxProps) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'tap-target inline-flex cursor-pointer items-center gap-2.5 text-small text-text',
        wrapperClassName,
      )}
    >
      <input
        {...rest}
        id={id}
        type="checkbox"
        className={cn('size-[1.125rem] shrink-0 accent-signal-ink', className)}
      />
      <span>{label}</span>
    </label>
  );
}
