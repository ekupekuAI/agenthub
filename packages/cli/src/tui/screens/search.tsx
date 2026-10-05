/**
 * Search results: a selectable list with verdict badges, agent chips and summaries. Typing at
 * the prompt refines the query live.
 */
import type { SearchResult } from '@agenthub/core';
import { Box, Text } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { AgentIds, VerdictBadge } from '../components/badges';
import { T } from '../components/primitives';
import { useApp, useKeys, useTheme } from '../hooks/context';
import { moveSelection, useSelection } from '../hooks/list';
import { formatMs, useReveal } from '../hooks/motion';
import { useTask } from '../hooks/task';
import { fit, safe } from '../sanitize';
import { Footer, ScreenTitle, TaskView } from './common';

export function useDebounced<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return current;
}

export function SearchScreen({ query }: { query: string }) {
  const app = useApp();
  const debounced = useDebounced(query, 220);
  const [state] = useTask(() => app.session.search(debounced), [debounced]);
  // While a refined query runs, keep showing the previous results (marked as refreshing).
  const last = useRef<{
    query: string;
    value: Awaited<ReturnType<typeof app.session.search>>;
  } | null>(null);
  if (state.status === 'done') last.current = { query: debounced, value: state.value };
  if (state.status === 'loading' && last.current !== null) {
    const previous = last.current;
    return (
      <Box flexDirection="column" paddingX={1}>
        <Results
          query={previous.query}
          results={previous.value.value.results}
          registry={previous.value.value.registry}
          ms={previous.value.ms}
          stale
        />
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <TaskView state={state} loading={`Searching for “${safe(debounced)}”`} what="Search failed">
        {(found) => (
          <Results
            query={debounced}
            results={found.value.results}
            registry={found.value.registry}
            ms={found.ms}
            stale={debounced !== query}
          />
        )}
      </TaskView>
    </Box>
  );
}

function Results({
  query,
  results,
  registry,
  ms,
  stale,
}: {
  query: string;
  results: SearchResult[];
  registry: string;
  ms: number;
  stale: boolean;
}) {
  const app = useApp();
  const theme = useTheme();
  const g = theme.glyphs;
  const [selected, setSelected] = useSelection(results.length);
  const perRow = 3;
  const capacity = Math.max(1, Math.floor((app.rows - 6) / perRow));
  const start = Math.min(
    Math.max(0, selected - Math.floor(capacity / 2)),
    Math.max(0, results.length - capacity),
  );
  const visible = results.slice(start, start + capacity);
  const shown = useReveal(visible.length, { key: query, step: 1, interval: 60 });
  const current = results[selected];

  useKeys((input, key) => {
    const next = moveSelection(selected, results.length, input, key);
    if (next !== null) {
      setSelected(next);
      return true;
    }
    if (current === undefined) return false;
    if (key.return) {
      app.navigate({ kind: 'detail', name: current.slug });
      return true;
    }
    if (input === 'i') {
      app.navigate({ kind: 'install', target: current.slug });
      return true;
    }
    if (input === 'd') {
      app.navigate({ kind: 'diff', name: current.slug });
      return true;
    }
    return false;
  });

  const nameWidth = Math.min(28, Math.max(12, ...results.map((r) => safe(r.slug).length + 1)));
  const summaryWidth = Math.max(20, app.columns - 8);
  return (
    <Box flexDirection="column">
      <ScreenTitle
        title={
          <Text>
            <T tone="text" bold>
              Search
            </T>
            <T tone="muted">{`  “${safe(query)}”`}</T>
            {stale ? <T tone="subtle">{`  ${g.ellipsis}`}</T> : null}
          </Text>
        }
        meta={
          <T tone="subtle">{`${results.length} result${results.length === 1 ? '' : 's'} ${g.sep} ${formatMs(ms)}`}</T>
        }
        subtitle={<T tone="subtle">{fit(`registry ${safe(registry)}`, app.columns - 4)}</T>}
      />
      {results.length === 0 ? (
        <Box flexDirection="column">
          <T tone="text">No skills match.</T>
          <T tone="muted">Try fewer words, or a category name.</T>
        </Box>
      ) : null}
      {visible.slice(0, shown).map((result, offset) => {
        const index = start + offset;
        const active = index === selected;
        return (
          <Box key={result.slug} flexDirection="column" marginBottom={1}>
            <Box>
              <Box width={2}>
                <T tone="signal">{active ? g.pointer : ' '}</T>
              </Box>
              <Box width={nameWidth}>
                <T tone={active ? 'signal' : 'text'} bold>
                  {fit(safe(result.slug), nameWidth - 1)}
                </T>
              </Box>
              <Box width={10}>
                <T tone="muted">{fit(safe(result.latestVersion ?? '—'), 9)}</T>
              </Box>
              <Box width={11}>
                <VerdictBadge outcome={result.scanOutcome} />
              </Box>
              <Box flexGrow={1}>
                <AgentIds ids={result.agents} />
              </Box>
              {result.publisher === undefined ? null : (
                <Text>
                  <T tone="subtle">{safe(result.publisher.name)}</T>
                  {result.publisher.verified ? <T tone="signal">{` ${g.ok}`}</T> : null}
                </Text>
              )}
            </Box>
            <Box paddingLeft={2}>
              <T tone={active ? 'text' : 'muted'}>{fit(safe(result.summary), summaryWidth)}</T>
            </Box>
          </Box>
        );
      })}
      {results.length > 0 ? (
        <Footer
          hints={[
            [`${g.up}${g.down}`, 'select'],
            ['enter', 'details'],
            ['i', 'install'],
            ['d', 'diff'],
            ['type', 'refine'],
            ['esc', 'back'],
          ]}
        />
      ) : null}
    </Box>
  );
}
