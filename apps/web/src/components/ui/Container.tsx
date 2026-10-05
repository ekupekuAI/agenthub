import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export type ContainerWidth = 'page' | 'reading' | 'wide';

const WIDTHS: Record<ContainerWidth, string> = {
  /** 1120px: the default content width. */
  page: 'max-w-page',
  /** 720px: long-form prose. */
  reading: 'max-w-reading',
  /** 1280px: full-bleed sections such as the hero. */
  wide: 'max-w-wide',
};

export interface ContainerProps extends HTMLAttributes<HTMLElement> {
  width?: ContainerWidth;
  as?: 'div' | 'section' | 'header' | 'footer' | 'article' | 'nav';
}

/** Centered column with the page gutters (16px, 24px from 640px, 32px from 1024px). */
export function Container({ width = 'page', as: Tag = 'div', className, ...rest }: ContainerProps) {
  return (
    <Tag
      {...rest}
      className={cn('mx-auto w-full px-4 sm:px-6 lg:px-8', WIDTHS[width], className)}
    />
  );
}

export interface SectionProps extends HTMLAttributes<HTMLElement> {
  /** Vertical rhythm: `default` is 56px on mobile and 96px from 1024px; `tight` is half. */
  spacing?: 'default' | 'tight' | 'none';
  /** Draw a hairline above the section. */
  divided?: boolean;
}

/** A page section with the standard vertical rhythm. Put a Container inside. */
export function Section({
  spacing = 'default',
  divided = false,
  className,
  ...rest
}: SectionProps) {
  return (
    <section
      {...rest}
      className={cn(
        spacing === 'default' && 'py-14 lg:py-24',
        spacing === 'tight' && 'py-8 lg:py-12',
        divided && 'border-border border-t',
        className,
      )}
    />
  );
}
