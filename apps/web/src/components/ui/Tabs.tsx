'use client';

import { motion } from 'motion/react';
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';
import { cn } from '../../lib/cn';

export type TabsVariant = 'underline' | 'pill' | 'chrome';

export interface TabDescriptor {
  id: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface TabItem extends TabDescriptor {
  /** Panel content. May be server-rendered and passed in as a prop. */
  content: ReactNode;
}

export interface TabListProps {
  tabs: readonly TabDescriptor[];
  /** Id of the selected tab. */
  value: string;
  onChange: (id: string) => void;
  /** Prefix for element ids: tabs are `${idBase}-tab-${id}`, panels `${idBase}-panel-${id}`. */
  idBase: string;
  /** Accessible name of the tab list. */
  label: string;
  variant?: TabsVariant;
  className?: string;
}

export function tabId(idBase: string, id: string): string {
  return `${idBase}-tab-${id}`;
}

export function tabPanelId(idBase: string, id: string): string {
  return `${idBase}-panel-${id}`;
}

const LIST: Record<TabsVariant, string> = {
  underline: 'gap-1 border-border border-b',
  pill: 'gap-1 rounded-control border border-border bg-surface-2 p-1',
  chrome: 'gap-0.5',
};

const TAB: Record<TabsVariant, { base: string; on: string; off: string }> = {
  underline: {
    base: 'h-11 px-3 text-small font-medium',
    on: 'text-text',
    off: 'text-muted hover:text-text',
  },
  pill: {
    base: 'h-9 rounded-chip px-3 text-small font-medium',
    on: 'text-text',
    off: 'text-muted hover:text-text',
  },
  chrome: {
    base: 'h-8 rounded-chip px-2 font-mono text-[0.75rem]',
    on: 'text-text',
    off: 'text-subtle hover:text-text',
  },
};

/**
 * The tab strip on its own (WAI-ARIA tabs with automatic activation): Left/Right move and
 * select, Home/End jump, only the selected tab is in the Tab order. Pair every tab with an
 * element that has role="tabpanel", id={tabPanelId(...)} and aria-labelledby={tabId(...)}.
 */
export function TabList({
  tabs,
  value,
  onChange,
  idBase,
  label,
  variant = 'underline',
  className,
}: TabListProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const styles = TAB[variant];

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const enabled = tabs.filter((tab) => !tab.disabled);
    const index = enabled.findIndex((tab) => tab.id === value);
    if (enabled.length === 0) return;
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % enabled.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + enabled.length) % enabled.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = enabled.length - 1;
    else return;
    event.preventDefault();
    const target = enabled[next];
    if (!target) return;
    onChange(target.id);
    listRef.current
      ?.querySelector<HTMLElement>(`#${CSS.escape(tabId(idBase, target.id))}`)
      ?.focus();
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        'flex max-w-full items-center overflow-x-auto [scrollbar-width:none]',
        LIST[variant],
        className,
      )}
    >
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tabId(idBase, tab.id)}
            aria-selected={selected}
            aria-controls={tabPanelId(idBase, tab.id)}
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            className={cn(
              'tap-target relative inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-colors duration-150 disabled:opacity-50',
              styles.base,
              selected ? styles.on : styles.off,
            )}
          >
            {selected && variant !== 'underline' ? (
              <motion.span
                layoutId={`${idBase}-indicator`}
                aria-hidden="true"
                className={cn(
                  'absolute inset-0 rounded-chip',
                  variant === 'pill' ? 'border border-border-strong bg-surface-1' : 'bg-surface-3',
                )}
                transition={{ type: 'spring', stiffness: 300, damping: 26 }}
              />
            ) : null}
            {selected && variant === 'underline' ? (
              <motion.span
                layoutId={`${idBase}-indicator`}
                aria-hidden="true"
                className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-signal-ink"
                transition={{ type: 'spring', stiffness: 300, damping: 26 }}
              />
            ) : null}
            <span className="relative">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export interface TabsProps {
  tabs: readonly TabItem[];
  /** Accessible name of the tab list. */
  label: string;
  /** Initially selected tab (uncontrolled). Defaults to the first tab. */
  defaultValue?: string;
  /** Selected tab (controlled). */
  value?: string;
  onValueChange?: (id: string) => void;
  variant?: TabsVariant;
  className?: string;
  listClassName?: string;
  panelClassName?: string;
}

/** Tab list plus panels. Only the selected panel is rendered. */
export function Tabs({
  tabs,
  label,
  defaultValue,
  value,
  onValueChange,
  variant = 'underline',
  className,
  listClassName,
  panelClassName,
}: TabsProps) {
  const idBase = useId();
  const [internal, setInternal] = useState(defaultValue ?? tabs[0]?.id ?? '');
  const selected = value ?? internal;
  const active = tabs.find((tab) => tab.id === selected) ?? tabs[0];

  function change(id: string) {
    if (value === undefined) setInternal(id);
    onValueChange?.(id);
  }

  if (!active) return null;
  return (
    <div className={className}>
      <TabList
        tabs={tabs}
        value={active.id}
        onChange={change}
        idBase={idBase}
        label={label}
        variant={variant}
        className={listClassName}
      />
      <div
        role="tabpanel"
        id={tabPanelId(idBase, active.id)}
        aria-labelledby={tabId(idBase, active.id)}
        className={cn('pt-6', panelClassName)}
      >
        {active.content}
      </div>
    </div>
  );
}
