import type { InputHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { CONTROL_CLASSES, type ComposedFieldProps, describedBy, Field } from './Field';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Marks the control invalid (sets aria-invalid and the error border). */
  invalid?: boolean;
  /** Mono font for tokens, digests and versions. */
  mono?: boolean;
}

/** Bare text input. It needs a label: use TextField, or wrap it in a Field. */
export function Input({ invalid, mono, className, type = 'text', ...rest }: InputProps) {
  return (
    <input
      {...rest}
      type={type}
      aria-invalid={invalid || undefined}
      className={cn(CONTROL_CLASSES, 'h-11 sm:h-10', mono && 'font-mono', className)}
    />
  );
}

export type TextFieldProps = ComposedFieldProps & Omit<InputProps, 'id' | 'invalid'>;

/** Field + Input with ids, aria-describedby and aria-invalid wired up. */
export function TextField({
  id,
  label,
  hint,
  error,
  optional,
  fieldClassName,
  ...input
}: TextFieldProps) {
  return (
    <Field
      id={id}
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      className={fieldClassName}
    >
      <Input
        {...input}
        id={id}
        invalid={Boolean(error)}
        aria-describedby={describedBy(id, { hint, error })}
      />
    </Field>
  );
}
