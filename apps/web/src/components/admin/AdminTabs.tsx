'use client';

import { motion } from 'motion/react';
import { type ReactNode, useId, useState } from 'react';
import { cn } from '../../lib/cn';
import { TabList, tabId, tabPanelId } from '../ui';

export interface AdminTab {
  id: string;
  label: string;
  /** Shown as a chip after the label, e.g. the queue length. */
  count?: string;
  /** Screen-reader words after the count, e.g. "waiting for review". */
  countLabel?: string;
  /** Tints the count chip when the tab holds work that is waiting. */
  attention?: boolean;
  content: ReactNode;
}

export interface AdminTabsProps {
  tabs: readonly AdminTab[];
  /** Accessible name of the tab list. */
  label: string;
  className?: string;
}

/*
 * A moderation action ends in a redirect, which remounts the page. The selected tab is kept
 * here so the moderator returns to the tab they acted from. A full page load starts again
 * from the first tab, so server and client markup always agree.
 */
let rememberedTab: string | null = null;

/** Forget the selected tab (used on sign-out). */
export function resetAdminTab(): void {
  rememberedTab = null;
}

const EASE_OUT = [0.25, 1, 0.5, 1] as const;

/**
 * The console's tabs. Unlike the kit's Tabs, every panel stays mounted and the inactive ones
 * are hidden, so form state (a half-typed publisher name, a token that is shown only once)
 * survives a look at another tab.
 */
export function AdminTabs({ tabs, label, className }: AdminTabsProps) {
  const idBase = useId();
  const [selected, setSelected] = useState(() => rememberedTab ?? tabs[0]?.id ?? '');
  const active = tabs.find((tab) => tab.id === selected) ?? tabs[0];
  if (!active) return null;

  function change(id: string) {
    rememberedTab = id;
    setSelected(id);
  }

  return (
    <div className={className}>
      <TabList
        idBase={idBase}
        label={label}
        value={active.id}
        onChange={change}
        tabs={tabs.map((tab) => ({
          id: tab.id,
          label: (
            <span className="inline-flex items-center gap-2">
              {tab.label}
              {tab.count !== undefined ? (
                <span
                  className={cn(
                    'inline-flex h-5 min-w-5 items-center justify-center rounded-chip border px-1 font-mono text-[0.75rem] leading-none',
                    tab.attention
                      ? 'border-warn-line bg-warn-tint text-warn'
                      : 'border-border-strong bg-surface-2 text-muted',
                  )}
                >
                  {tab.count}
                  {tab.countLabel ? <span className="sr-only"> {tab.countLabel}</span> : null}
                </span>
              ) : null}
            </span>
          ),
        }))}
      />
      {tabs.map((tab) => {
        const shown = tab.id === active.id;
        return (
          <motion.div
            key={tab.id}
            role="tabpanel"
            id={tabPanelId(idBase, tab.id)}
            aria-labelledby={tabId(idBase, tab.id)}
            hidden={!shown}
            initial={false}
            animate={shown ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
            transition={shown ? { duration: 0.24, ease: EASE_OUT } : { duration: 0 }}
            className="pt-7 sm:pt-9"
          >
            {tab.content}
          </motion.div>
        );
      })}
    </div>
  );
}
