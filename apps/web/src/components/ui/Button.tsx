import Link from 'next/link';
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { LoaderIcon } from './icons';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonOwnProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and disables the button. Ignored for links. */
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  fullWidth?: boolean;
  className?: string;
  children?: ReactNode;
}

type ButtonAsButton = ButtonOwnProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonOwnProps> & { href?: undefined };

type ButtonAsLink = ButtonOwnProps &
  Omit<ComponentProps<typeof Link>, keyof ButtonOwnProps | 'href'> & { href: string };

export type ButtonProps = ButtonAsButton | ButtonAsLink;

const BASE =
  'tap-target inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-control border font-medium no-underline transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.98] active:duration-[120ms] disabled:pointer-events-none disabled:opacity-50';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'border-signal-line bg-signal text-on-signal hover:bg-signal-hover',
  secondary: 'border-border-strong bg-surface-2 text-text hover:bg-surface-3',
  ghost: 'border-transparent bg-transparent text-muted hover:bg-surface-2 hover:text-text',
  danger:
    'border-block-line bg-block-tint text-block hover:bg-[color-mix(in_oklab,var(--block)_24%,transparent)]',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[0.8125rem] leading-5',
  md: 'h-10 px-4 text-small',
  lg: 'h-12 px-5 text-body',
};

/** Class string for elements that must look like a Button but cannot be one (label, summary). */
export function buttonClasses(
  options: {
    variant?: ButtonVariant;
    size?: ButtonSize;
    fullWidth?: boolean;
    className?: string;
  } = {},
): string {
  const { variant = 'secondary', size = 'md', fullWidth = false, className } = options;
  return cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && 'w-full', className);
}

/**
 * The standard button. With `href` it renders a Next.js <Link> that looks the same.
 * Works in server components; pass event handlers only from client components.
 */
export function Button(props: ButtonProps) {
  if (props.href !== undefined) {
    const {
      variant,
      size,
      loading: _loading,
      leadingIcon,
      trailingIcon,
      fullWidth,
      className,
      children,
      ...rest
    } = props;
    return (
      <Link {...rest} className={buttonClasses({ variant, size, fullWidth, className })}>
        {leadingIcon}
        {children}
        {trailingIcon}
      </Link>
    );
  }

  const {
    variant,
    size,
    loading = false,
    leadingIcon,
    trailingIcon,
    fullWidth,
    className,
    children,
    type = 'button',
    disabled,
    href: _href,
    ...rest
  } = props;
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses({ variant, size, fullWidth, className })}
    >
      {loading ? <LoaderIcon className="animate-spinner" /> : leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
}
