/**
 * Help: keys, slash commands and environment variables.
 */
import { Box, Text } from 'ink';
import { COMMANDS } from '../commands';
import { Panel, T } from '../components/primitives';
import { useApp, useKeys, useTheme } from '../hooks/context';
import { Footer, Scroll, split } from './common';

export const ENVIRONMENT: readonly (readonly [string, string])[] = [
  ['NO_COLOR', 'no colors (same as --no-color, or /theme mono)'],
  ['AGENTHUB_REDUCED_MOTION=1', 'no animations: final states render at once'],
  ['AGENTHUB_ASCII=1', 'ASCII borders, symbols and spinners'],
  ['AGENTHUB_UNICODE=1', 'full symbol set on the classic console'],
  ['AGENTHUB_NO_TUI=1', 'never open the interactive mode'],
  ['FORCE_COLOR=1|2|3', 'force 16, 256 or 24-bit colors'],
  ['AGENTHUB_REGISTRY', 'registry to use (https://… or file:<folder>)'],
];

export function HelpScreen() {
  const app = useApp();
  const theme = useTheme();
  const g = theme.glyphs;
  useKeys((input, key) => {
    if (input === '?' || input === 'q' || key.return) {
      app.back();
      return true;
    }
    return false;
  });
  const keys: readonly (readonly [string, string])[] = [
    ['/', 'open the command palette'],
    ['text + enter', 'search the registry (refines live on the results)'],
    [`${g.up} ${g.down}  j k`, 'move; PgUp PgDn scroll'],
    ['tab', 'complete a command or a skill name'],
    ['enter', 'open or run the selection'],
    ['esc', 'close the palette, clear the prompt, go back'],
    ['?', 'this help (when the prompt is empty)'],
    ['q', 'quit from the home screen'],
    ['ctrl+c', 'quit (waits for a running transaction)'],
  ];
  const wide = app.columns >= 110;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Scroll height={Math.max(6, app.rows - 4)}>
        <Box flexDirection={wide ? 'row' : 'column'} gap={wide ? 1 : 0}>
          <Box flexDirection="column" {...split(wide)}>
            <Panel title="Keys">
              {keys.map(([key, text]) => (
                <Box key={key}>
                  <Box width={16}>
                    <T tone="text" bold>
                      {key}
                    </T>
                  </Box>
                  <T tone="muted">{text}</T>
                </Box>
              ))}
            </Panel>
            <Panel title="Environment">
              {ENVIRONMENT.map(([name, text]) => (
                <Box key={name} flexDirection="column">
                  <T tone="info">{name}</T>
                  <Box paddingLeft={2}>
                    <T tone="muted">{text}</T>
                  </Box>
                </Box>
              ))}
            </Panel>
          </Box>
          <Panel title="Commands" {...split(wide)}>
            {COMMANDS.map((command) => (
              <Box key={command.name} flexDirection="column">
                <Text>
                  <T tone="signal">{`/${command.name}`}</T>
                  <T tone="subtle">{command.args === undefined ? '' : ` ${command.args}`}</T>
                </Text>
                <Box paddingLeft={2}>
                  <T tone="muted">{command.description}</T>
                </Box>
              </Box>
            ))}
            <Box marginTop={1}>
              <T tone="subtle">
                Every subcommand still works on its own: agenthub install x --json, …
              </T>
            </Box>
          </Panel>
        </Box>
      </Scroll>
      <Footer
        hints={[
          [`${g.up}${g.down}`, 'scroll'],
          ['esc', 'close'],
        ]}
      />
    </Box>
  );
}
