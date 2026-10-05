import type { SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { CONTROL_CLASSES, type ComposedFieldProps, describedBy, Field } from './Field';
import { ChevronDownIcon } from './icons';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
  /** Classes for the wrapper that positions the chevron (use for width). */
  wrapperClassName?: string;
}

/** Native select with the kit's look. It needs a label: use SelectField, or a Field. */
export function Select({ invalid, className, wrapperClassName, children, ...rest }: SelectProps) {
  return (
    <span className={cn('relative block min-w-0', wrapperClassName)}>
      <select
        {...rest}
        aria-invalid={invalid || undefined}
        className={cn(CONTROL_CLASSES, 'h-11 appearance-none pr-9 sm:h-10', className)}
      >
        {children}
      </select>
      <ChevronDownIcon
        size={16}
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-subtle"
      />
    </span>
  );
}

export type SelectFieldProps = ComposedFieldProps & Omit<SelectProps, 'id' | 'invalid'>;

/** Field + Select with ids, aria-describedby and aria-invalid wired up. */
export function SelectField({
  id,
  label,
  hint,
  error,
  optional,
  fieldClassName,
  children,
  ...select
}: SelectFieldProps) {
  return (
    <Field
      id={id}
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      className={fieldClassName}
    >
      <Select
        {...select}
        id={id}
        invalid={Boolean(error)}
        aria-describedby={describedBy(id, { hint, error })}
      >
        {children}
      </Select>
    </Field>
  );
}
