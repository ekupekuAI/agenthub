import Link from 'next/link';
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface ShimmerOwnProps {
  className?: string;
  children?: ReactNode;
}

type ShimmerAsButton = ShimmerOwnProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ShimmerOwnProps> & { href?: undefined };

type ShimmerAsLink = ShimmerOwnProps &
  Omit<ComponentProps<typeof Link>, keyof ShimmerOwnProps | 'href'> & { href: string };

export type ShimmerButtonProps = ShimmerAsButton | ShimmerAsLink;

const CLASSES =
  'shimmer tap-target inline-flex h-12 shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap px-6 text-body font-medium no-underline transition-transform duration-150 ease-out active:scale-[0.98] active:duration-[120ms] disabled:pointer-events-none disabled:opacity-50';

/** The moving light and the layers that confine it to the pill's border. Decorative. */
function ShimmerLayers() {
  return (
    <>
      <span className="shimmer-track" aria-hidden="true">
        <span className="shimmer-slide">
          <span className="shimmer-spark" />
        </span>
      </span>
      <span className="shimmer-backdrop" aria-hidden="true" />
      <span className="shimmer-sheen" aria-hidden="true" />
    </>
  );
}

/**
 * Hero call to action: a dark pill with a signal-colored light travelling around its border
 * (adapted from the Magic UI "Shimmer Button").
 * Use once per page. With `href` it renders a Next.js <Link>. The light stops under
 * prefers-reduced-motion and a static signal hairline remains.
 */
export function ShimmerButton(props: ShimmerButtonProps) {
  if (props.href !== undefined) {
    const { className, children, ...rest } = props;
    return (
      <Link {...rest} className={cn(CLASSES, className)}>
        <ShimmerLayers />
        {children}
      </Link>
    );
  }
  const { className, children, type = 'button', href: _href, ...rest } = props;
  return (
    <button {...rest} type={type} className={cn(CLASSES, className)}>
      <ShimmerLayers />
      {children}
    </button>
  );
}
