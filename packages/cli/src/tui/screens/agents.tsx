/**
 * /agents: choose which agents installs target for this session (space toggles). Without a
 * choice agenthub targets the detected agents with high or medium confidence, as the classic CLI
 * does without --agent.
 */
import type { AgentEnvironment, AgentId } from '@agenthub/core';
import { AGENT_IDS } from '@agenthub/core';
import { Box, Text } from 'ink';
import { useState } from 'react';
import { AGENT_NAMES, AgentChip } from '../components/badges';
import { Panel, T } from '../components/primitives';
import { useApp, useKeys, useTheme } from '../hooks/context';
import { moveSelection } from '../hooks/list';
import { safe } from '../sanitize';
import { Footer } from './common';

export function defaultTargets(agents: readonly AgentEnvironment[]): AgentId[] {
  return AGENT_IDS.filter((id) =>
    agents.some((agent) => agent.id === id && agent.confidence !== 'low'),
  );
}

export function AgentsScreen({
  detected,
  selected,
  onApply,
}: {
  detected: readonly AgentEnvironment[];
  selected: readonly AgentId[] | undefined;
  onApply: (agents: AgentId[] | null) => void;
}) {
  const app = useApp();
  const theme = useTheme();
  const g = theme.glyphs;
  const [cursor, setCursor] = useState(0);
  const [picked, setChosen] = useState<AgentId[] | null>(null);
  // Until the person toggles something, follow the current choice (detection may still be
  // running when the screen opens).
  const chosen = picked ?? [...(selected ?? defaultTargets(detected))];

  useKeys(
    (input, key) => {
      const next = moveSelection(cursor, AGENT_IDS.length, input, key);
      if (next !== null) {
        setCursor(next);
        return true;
      }
      const id = AGENT_IDS[cursor];
      if (input === ' ' && id !== undefined) {
        setChosen(() =>
          chosen.includes(id)
            ? chosen.filter((x) => x !== id)
            : AGENT_IDS.filter((x) => x === id || chosen.includes(x)),
        );
        return true;
      }
      if (input === 'a') {
        setChosen([...AGENT_IDS]);
        return true;
      }
      if (input === 'r') {
        onApply(null);
        return true;
      }
      if (key.return) {
        if (chosen.length === 0) {
          app.toast('warn', 'select at least one agent (space), or press r for the detected ones');
          return true;
        }
        onApply(chosen);
        return true;
      }
      if (key.escape) {
        app.back();
        return true;
      }
      return false;
    },
    { modal: true },
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Panel
        title="Target agents"
        aside={
          <T tone="subtle">
            {selected === undefined ? 'using detection' : 'chosen for this session'}
          </T>
        }
      >
        <Box marginTop={1} flexDirection="column">
          {AGENT_IDS.map((id, index) => {
            const env = detected.find((agent) => agent.id === id);
            const on = chosen.includes(id);
            const active = index === cursor;
            return (
              <Box key={id}>
                <Box width={2}>
                  <T tone="signal">{active ? g.pointer : ' '}</T>
                </Box>
                <Box width={5}>
                  <T tone={on ? 'signal' : 'subtle'} bold>
                    {on ? `[${g.ok === '+' ? 'x' : g.ok}]` : '[ ]'}
                  </T>
                </Box>
                <Box width={6}>
                  <AgentChip id={id} off={!on} />
                </Box>
                <Box width={14}>
                  <T tone={active ? 'text' : 'muted'} bold={active}>
                    {AGENT_NAMES[id]}
                  </T>
                </Box>
                {env === undefined ? (
                  <T tone="subtle">not detected</T>
                ) : (
                  <Text>
                    <T
                      tone={
                        env.confidence === 'high'
                          ? 'signal'
                          : env.confidence === 'medium'
                            ? 'info'
                            : 'subtle'
                      }
                    >
                      {env.confidence}
                    </T>
                    <T tone="subtle">{`  ${safe(env.evidence[0] ?? '')}`}</T>
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>
        <Box marginTop={1}>
          <T tone="subtle">
            Claude Code reads .claude/skills, Codex reads .agents/skills, Cursor and VS Code read
            both.
          </T>
        </Box>
      </Panel>
      <Footer
        hints={[
          ['space', 'toggle'],
          ['a', 'all'],
          ['r', 'use detection'],
          ['enter', 'apply'],
          ['esc', 'cancel'],
        ]}
      />
    </Box>
  );
}
