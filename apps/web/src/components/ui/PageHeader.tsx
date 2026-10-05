import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Container, type ContainerWidth } from './Container';
import { SectionHeading } from './SectionHeading';

export interface PageHeaderProps {
  eyebrow?: ReactNode;
  /** The page <h1>. Wrap the one emphasized word in <em>. */
  title: ReactNode;
  lede?: ReactNode;
  /** Rendered above the eyebrow, e.g. a breadcrumb <nav>. */
  breadcrumb?: ReactNode;
  actions?: ReactNode;
  /** Extra content under the lede (a CopyCommand, filters). */
  children?: ReactNode;
  width?: ContainerWidth;
  className?: string;
}

/**
 * Standard header for inner pages: dot-grid texture, eyebrow, serif h1, lede and a hairline.
 * The home page builds its own hero.
 */
export function PageHeader({
  eyebrow,
  title,
  lede,
  breadcrumb,
  actions,
  children,
  width = 'page',
  className,
}: PageHeaderProps) {
  return (
    <header className={cn('dot-grid border-border border-b', className)}>
      <Container width={width} className="pt-10 pb-10 sm:pt-14 sm:pb-12">
        {breadcrumb ? <div className="mb-6">{breadcrumb}</div> : null}
        <SectionHeading
          as="h1"
          size="display-2"
          eyebrow={eyebrow}
          title={title}
          lede={lede}
          actions={actions}
        />
        {children ? <div className="mt-6">{children}</div> : null}
      </Container>
    </header>
  );
}
