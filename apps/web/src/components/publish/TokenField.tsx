'use client';

import { type InputHTMLAttributes, type ReactNode, useEffect, useRef, useState } from 'react';
import { describedBy, EyeIcon, Field, Input } from '../ui';

export interface TokenFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type' | 'className'> {
  /** Id of the input; the label, hint and error are tied to it. */
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Classes for the field wrapper. */
  fieldClassName?: string;
}

/** Lucide "eye-off", drawn like the kit icons (24px grid, 1.5px stroke). */
function EyeOffIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable={false}
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </svg>
  );
}

/**
 * A secret token input: masked by default, with a toggle to check what was pasted. The value
 * lives only in the input; nothing here writes it to storage. The field masks itself again
 * when its form is reset.
 */
export function TokenField({ id, label, hint, error, fieldClassName, ...input }: TokenFieldProps) {
  const [visible, setVisible] = useState(false);
  const wrapper = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const form = wrapper.current?.closest('form');
    if (!form) return;
    const onReset = () => setVisible(false);
    form.addEventListener('reset', onReset);
    return () => form.removeEventListener('reset', onReset);
  }, []);

  return (
    <Field id={id} label={label} hint={hint} error={error} className={fieldClassName}>
      <div ref={wrapper} className="relative">
        <Input
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          {...input}
          id={id}
          type={visible ? 'text' : 'password'}
          mono
          invalid={Boolean(error)}
          aria-describedby={describedBy(id, { hint, error })}
          className="pr-12"
        />
        <button
          type="button"
          aria-pressed={visible}
          aria-controls={id}
          disabled={input.disabled}
          onClick={() => setVisible((shown) => !shown)}
          className="absolute top-0 right-0 inline-flex h-full w-11 items-center justify-center rounded-control text-muted transition-colors duration-150 hover:text-text disabled:pointer-events-none disabled:opacity-50"
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
          <span className="sr-only">Show token</span>
        </button>
      </div>
    </Field>
  );
}
