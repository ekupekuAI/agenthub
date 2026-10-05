import type { TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { CONTROL_CLASSES, type ComposedFieldProps, describedBy, Field } from './Field';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  mono?: boolean;
}

/** Bare textarea. It needs a label: use TextareaField, or wrap it in a Field. */
export function Textarea({ invalid, mono, className, rows = 4, ...rest }: TextareaProps) {
  return (
    <textarea
      {...rest}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(CONTROL_CLASSES, 'min-h-24 resize-y py-2.5', mono && 'font-mono', className)}
    />
  );
}

export type TextareaFieldProps = ComposedFieldProps & Omit<TextareaProps, 'id' | 'invalid'>;

/** Field + Textarea with ids, aria-describedby and aria-invalid wired up. */
export function TextareaField({
  id,
  label,
  hint,
  error,
  optional,
  fieldClassName,
  ...textarea
}: TextareaFieldProps) {
  return (
    <Field
      id={id}
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      className={fieldClassName}
    >
      <Textarea
        {...textarea}
        id={id}
        invalid={Boolean(error)}
        aria-describedby={describedBy(id, { hint, error })}
      />
    </Field>
  );
}
