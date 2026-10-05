'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '../../lib/cn';
import { AgentStrip } from './AgentStrip';
import { AGENT_IDS, type AgentId } from './agents';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BookOpenIcon,
  ClockIcon,
  CornerDownLeftIcon,
  LayoutDashboardIcon,
  LoaderIcon,
  PackageIcon,
  SearchIcon,
  UploadIcon,
} from './icons';
import { Kbd } from './Kbd';
import { Modal } from './Modal';
import { OutcomeBadge, type ScanOutcomeValue } from './OutcomeBadge';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface SkillHit {
  slug: string;
  name: string;
  summary: string;
  latestVersion: string | null;
  agents: AgentId[];
  scanOutcome: ScanOutcomeValue | null;
}

interface RecentSkill {
  slug: string;
  name: string;
}

interface PaletteEntry {
  key: string;
  group: 'Skills' | 'Recent' | 'Pages';
  href: string;
  node: ReactNode;
  recent?: RecentSkill;
}

const PAGES = [
  {
    href: '/guidelines',
    label: 'Guidelines',
    hint: 'Install safely, write and publish a skill',
    icon: <BookOpenIcon size={16} />,
  },
  {
    href: '/publish',
    label: 'Publish',
    hint: 'Upload a .skillpkg and see its scan',
    icon: <UploadIcon size={16} />,
  },
  {
    href: '/dashboard',
    label: 'Dashboard',
    hint: 'Your published skills and versions',
    icon: <LayoutDashboardIcon size={16} />,
  },
] as const;

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RECENT_KEY = 'agenthub-recent';
const RECENT_MAX = 5;
const DEBOUNCE_MS = 180;

function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value);
}

/** Validates the search response instead of trusting its shape. */
function parseHits(payload: unknown): SkillHit[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return [];
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const hits: SkillHit[] = [];
  for (const raw of results) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.slug !== 'string' || !SLUG_RE.test(row.slug) || row.slug.length > 64) continue;
    const outcome = row.scanOutcome;
    hits.push({
      slug: row.slug,
      name: typeof row.name === 'string' ? row.name : row.slug,
      summary: typeof row.summary === 'string' ? row.summary : '',
      latestVersion: typeof row.latestVersion === 'string' ? row.latestVersion : null,
      agents: Array.isArray(row.agents) ? row.agents.filter(isAgentId) : [],
      scanOutcome:
        outcome === 'allow' || outcome === 'confirm' || outcome === 'block' ? outcome : null,
    });
  }
  return hits.slice(0, 8);
}

function readRecent(): RecentSkill[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const out: RecentSkill[] = [];
    for (const raw of parsed) {
      if (typeof raw !== 'object' || raw === null) continue;
      const { slug, name } = raw as Record<string, unknown>;
      if (typeof slug !== 'string' || !SLUG_RE.test(slug) || slug.length > 64) continue;
      out.push({ slug, name: typeof name === 'string' ? name.slice(0, 80) : slug });
    }
    return out.slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function rememberRecent(skill: RecentSkill): void {
  try {
    const next = [skill, ...readRecent().filter((item) => item.slug !== skill.slug)];
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next.slice(0, RECENT_MAX)));
  } catch {
    // Storage can be unavailable (private mode, quota); recents are a convenience only.
  }
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

type SearchState = 'idle' | 'loading' | 'done' | 'error';

function PaletteBody({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const id = useId();
  const listId = `${id}-list`;
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SkillHit[]>([]);
  const [state, setState] = useState<SearchState>('idle');
  const [recent, setRecent] = useState<RecentSkill[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const term = query.trim();

  useEffect(() => {
    setRecent(readRecent());
  }, []);

  useEffect(() => {
    if (term === '') {
      setHits([]);
      setState('idle');
      return;
    }
    setState('loading');
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/v1/skills?q=${encodeURIComponent(term)}&limit=8`, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`search failed with ${response.status}`);
        setHits(parseHits(await response.json()));
        setState('done');
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setHits([]);
        setState('error');
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term]);

  const entries = useMemo<PaletteEntry[]>(() => {
    const out: PaletteEntry[] = [];
    for (const hit of hits) {
      out.push({
        key: `skill:${hit.slug}`,
        group: 'Skills',
        href: `/skills/${hit.slug}`,
        recent: { slug: hit.slug, name: hit.name },
        node: (
          <>
            <span className="mt-0.5 shrink-0 text-subtle">
              <PackageIcon size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="truncate font-mono text-mono text-text">{hit.name}</span>
                {hit.latestVersion ? (
                  <span className="shrink-0 font-mono text-[0.75rem] text-subtle">
                    v{hit.latestVersion}
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 line-clamp-1 text-[0.8125rem] text-muted leading-5">
                {hit.summary}
              </span>
              <span className="mt-1.5 flex flex-wrap items-center gap-2">
                <OutcomeBadge outcome={hit.scanOutcome} />
                <AgentStrip supported={hit.agents} size="sm" />
              </span>
            </span>
          </>
        ),
      });
    }
    if (term === '') {
      for (const item of recent) {
        out.push({
          key: `recent:${item.slug}`,
          group: 'Recent',
          href: `/skills/${item.slug}`,
          recent: item,
          node: (
            <>
              <span className="shrink-0 text-subtle">
                <ClockIcon size={16} />
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-mono text-text">
                {item.name}
              </span>
            </>
          ),
        });
      }
    }
    const needle = term.toLowerCase();
    for (const page of PAGES) {
      if (needle !== '' && !`${page.label} ${page.hint}`.toLowerCase().includes(needle)) continue;
      out.push({
        key: `page:${page.href}`,
        group: 'Pages',
        href: page.href,
        node: (
          <>
            <span className="shrink-0 text-subtle">{page.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-small text-text">{page.label}</span>
              <span className="block truncate text-[0.8125rem] text-muted leading-5">
                {page.hint}
              </span>
            </span>
          </>
        ),
      });
    }
    return out;
  }, [hits, recent, term]);

  const activeIndex = entries.length === 0 ? -1 : Math.min(active, entries.length - 1);
  const activeEntry = activeIndex >= 0 ? entries[activeIndex] : undefined;
  const optionId = (index: number) => `${id}-option-${index}`;

  // Keep the keyboard-highlighted option visible. Only the list scrolls: scrollIntoView
  // would also move the locked page behind the palette.
  useEffect(() => {
    const list = listRef.current;
    if (!list || activeIndex < 0) return;
    const option = list.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    if (!option) return;
    const frame = list.getBoundingClientRect();
    const box = option.getBoundingClientRect();
    if (box.top < frame.top + 8) list.scrollTop -= frame.top + 8 - box.top;
    else if (box.bottom > frame.bottom - 8) list.scrollTop += box.bottom - (frame.bottom - 8);
  }, [activeIndex]);

  function choose(entry: PaletteEntry) {
    if (entry.recent) rememberRecent(entry.recent);
    onClose();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (entries.length > 0) setActive((activeIndex + 1) % entries.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (entries.length > 0) setActive((activeIndex - 1 + entries.length) % entries.length);
    } else if (event.key === 'Enter' && activeEntry) {
      event.preventDefault();
      choose(activeEntry);
      router.push(activeEntry.href);
    }
  }

  const status =
    state === 'loading'
      ? 'Searching'
      : state === 'error'
        ? 'Search is unavailable right now. Try again in a moment.'
        : term !== '' && hits.length === 0
          ? `No skills match "${term}".`
          : term !== ''
            ? `${hits.length} ${hits.length === 1 ? 'skill' : 'skills'} found.`
            : '';

  // Shown in the list when a search finished without skills (pages may still match).
  const notice = term !== '' && hits.length === 0 && (state === 'done' || state === 'error');
  const groups: PaletteEntry['group'][] = ['Skills', 'Recent', 'Pages'];

  return (
    <>
      <div className="flex items-center gap-3 border-border border-b px-4">
        <span className="shrink-0 text-subtle">
          {state === 'loading' ? (
            <LoaderIcon size={18} className="animate-spinner" />
          ) : (
            <SearchIcon size={18} />
          )}
        </span>
        <input
          data-autofocus=""
          type="text"
          role="combobox"
          aria-label="Search skills"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={200}
          placeholder="Search skills"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-14 min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-subtle"
        />
      </div>

      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Results"
        className="max-h-[min(60dvh,26rem)] overflow-y-auto p-2"
      >
        {notice ? <p className="px-2.5 pt-2 pb-2 text-muted text-small">{status}</p> : null}
        {groups.map((group) => {
          const items = entries
            .map((entry, index) => ({ entry, index }))
            .filter(({ entry }) => entry.group === group);
          if (items.length === 0) return null;
          const headingId = `${id}-group-${group}`;
          return (
            // biome-ignore lint/a11y/useSemanticElements: a group of listbox options, not a form fieldset
            <div key={group} role="group" aria-labelledby={headingId} className="mb-1 last:mb-0">
              <div id={headingId} className="eyebrow px-2.5 pt-2 pb-1.5">
                {group}
              </div>
              {items.map(({ entry, index }) => {
                const selected = index === activeIndex;
                return (
                  <Link
                    key={entry.key}
                    href={entry.href}
                    id={optionId(index)}
                    role="option"
                    aria-selected={selected}
                    tabIndex={-1}
                    data-index={index}
                    onClick={() => choose(entry)}
                    onPointerMove={() => setActive(index)}
                    className={cn(
                      'flex min-h-11 items-start gap-3 rounded-control px-2.5 py-2.5 no-underline',
                      selected ? 'bg-surface-3' : 'bg-transparent',
                    )}
                  >
                    {entry.node}
                    <span
                      aria-hidden="true"
                      className={cn(
                        'mt-0.5 shrink-0 text-subtle',
                        selected ? 'visible' : 'invisible',
                      )}
                    >
                      <CornerDownLeftIcon size={14} />
                    </span>
                  </Link>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-4 border-border border-t px-4 py-2.5 text-[0.75rem] text-subtle">
        <span className="inline-flex items-center gap-1.5">
          <Kbd>
            <ArrowUpIcon size={11} />
          </Kbd>
          <Kbd>
            <ArrowDownIcon size={11} />
          </Kbd>
          Navigate
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>
            <CornerDownLeftIcon size={11} />
          </Kbd>
          Open
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5">
          <Kbd>Esc</Kbd>
          Close
        </span>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
    </>
  );
}

/**
 * Global search (WAI-ARIA combobox with a listbox popup). Opens with Ctrl/⌘K or "/" and from
 * the header trigger; searches `/api/v1/skills?q=…&limit=8` after a short debounce; Up/Down
 * move, Enter opens, Esc closes; it closes itself when the route changes. Mount it once.
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const pathname = usePathname();
  const lastPath = useRef(pathname);

  useEffect(() => {
    if (lastPath.current !== pathname) {
      lastPath.current = pathname;
      onOpenChange(false);
    }
  }, [pathname, onOpenChange]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const key = event.key.toLowerCase();
      if (key === 'k' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        onOpenChange(!open);
        return;
      }
      if (
        key === '/' &&
        !open &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !isEditable(event.target)
      ) {
        event.preventDefault();
        onOpenChange(true);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  return (
    <Modal
      open={open}
      onClose={() => onOpenChange(false)}
      label="Search skills and pages"
      placement="top"
      className="flex w-full max-w-[40rem] flex-col overflow-hidden rounded-panel border border-border-strong bg-surface-1 shadow-pop"
    >
      <PaletteBody onClose={() => onOpenChange(false)} />
    </Modal>
  );
}
