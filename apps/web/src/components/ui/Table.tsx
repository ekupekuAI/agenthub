import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

/*
 * Explicit ARIA roles are set on every table element on purpose: under 640px the rows are
 * restyled as stacked cards (display: block / grid), which makes some browsers drop the
 * native table semantics. The roles keep rows, headers and cells announced correctly.
 */

export interface TableProps {
  /** Describes the table for assistive tech. Visually hidden unless `captionVisible`. */
  caption: string;
  captionVisible?: boolean;
  /** Turn rows into stacked cards under 640px. Give each TD a `label`. Default true. */
  stack?: boolean;
  /** Keep the header row visible under the site header while scrolling. Default true. */
  sticky?: boolean;
  /** Allow horizontal scrolling instead (disables the sticky header). */
  scroll?: boolean;
  /** Minimum width class for scrollable tables, e.g. `min-w-[40rem]`. */
  className?: string;
  /** Classes for the bordered frame around the table. */
  frameClassName?: string;
  children: ReactNode;
}

export function Table({
  caption,
  captionVisible = false,
  stack = true,
  sticky = true,
  scroll = false,
  className,
  frameClassName,
  children,
}: TableProps) {
  return (
    <div
      className={cn(
        'rounded-card border border-border bg-surface-1',
        scroll ? 'overflow-x-auto' : 'overflow-clip',
        frameClassName,
      )}
    >
      <table
        // biome-ignore lint/a11y/noRedundantRoles: keeps table semantics when rows are stacked with CSS
        role="table"
        data-stack={stack && !scroll ? 'true' : undefined}
        data-sticky={sticky && !scroll ? 'true' : undefined}
        className={cn('ledger-table', className)}
      >
        <caption
          className={captionVisible ? 'px-3.5 py-3 text-left text-muted text-small' : 'sr-only'}
        >
          {caption}
        </caption>
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: keeps table semantics when rows are stacked with CSS
    <thead role="rowgroup">{children}</thead>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: keeps table semantics when rows are stacked with CSS
    <tbody role="rowgroup">{children}</tbody>
  );
}

export function TR({ children, className }: { children: ReactNode; className?: string }) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: keeps table semantics when rows are stacked with CSS
    <tr role="row" className={className}>
      {children}
    </tr>
  );
}

export interface THProps extends Omit<ThHTMLAttributes<HTMLTableCellElement>, 'scope' | 'role'> {
  /** `col` for header-row cells (default), `row` for a row header inside TBody. */
  scope?: 'col' | 'row';
  /** Column label shown in stacked mode (only for `scope="row"` cells). */
  label?: string;
  align?: 'left' | 'right';
}

export function TH({ scope = 'col', label, align, className, children, ...rest }: THProps) {
  return (
    <th
      {...rest}
      role={scope === 'col' ? 'columnheader' : 'rowheader'}
      scope={scope}
      data-label={label}
      className={cn(align === 'right' && 'text-right', className)}
    >
      {children}
    </th>
  );
}

export interface TDProps extends Omit<TdHTMLAttributes<HTMLTableCellElement>, 'role'> {
  /** Column label shown before the value in stacked mode. */
  label?: string;
  /** Mono font for data columns: versions, digests, dates, counts. */
  mono?: boolean;
  align?: 'left' | 'right';
}

export function TD({ label, mono, align, className, children, ...rest }: TDProps) {
  return (
    <td
      {...rest}
      // biome-ignore lint/a11y/noRedundantRoles: keeps table semantics when rows are stacked with CSS
      role="cell"
      data-label={label}
      className={cn(
        mono ? 'font-mono text-mono text-text' : 'text-muted',
        align === 'right' && 'sm:text-right',
        className,
      )}
    >
      {children}
    </td>
  );
}
