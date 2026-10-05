/**
 * Slash commands of the interactive mode: the list shown in the palette, fuzzy matching and
 * parsing of what was typed at the prompt. Plain text (no leading "/") is a registry search.
 */

export type CommandName =
  | 'search'
  | 'install'
  | 'remove'
  | 'list'
  | 'update'
  | 'diff'
  | 'approve'
  | 'rollback'
  | 'verify'
  | 'doctor'
  | 'agents'
  | 'scope'
  | 'registry'
  | 'theme'
  | 'help'
  | 'clear'
  | 'quit';

export interface SlashCommand {
  name: CommandName;
  /** Argument synopsis shown after the name. */
  args?: string;
  description: string;
  group: 'Skills' | 'Trust' | 'Session';
  /** The command cannot run without an argument; Enter completes it instead. */
  needsArg?: boolean;
  aliases?: string[];
}

export const COMMANDS: readonly SlashCommand[] = [
  {
    name: 'search',
    args: '<query>',
    description: 'Search the registry',
    group: 'Skills',
    needsArg: true,
    aliases: ['find', 's'],
  },
  {
    name: 'install',
    args: '<name[@range] | ./folder | file.skillpkg>',
    description: 'Review the plan, then install',
    group: 'Skills',
    needsArg: true,
    aliases: ['add', 'i'],
  },
  {
    name: 'remove',
    args: '<skill>',
    description: 'Remove an installed skill',
    group: 'Skills',
    needsArg: true,
    aliases: ['rm', 'uninstall'],
  },
  {
    name: 'list',
    description: 'Installed skills, approval and status',
    group: 'Skills',
    aliases: ['ls'],
  },
  {
    name: 'update',
    args: '[skill]',
    description: 'Updates with their capability change',
    group: 'Skills',
    aliases: ['upgrade'],
  },
  {
    name: 'diff',
    args: '<skill>',
    description: 'What the next version can do that this one cannot',
    group: 'Trust',
    needsArg: true,
  },
  {
    name: 'approve',
    args: '<skill>',
    description: 'Review and approve the installed capability inventory',
    group: 'Trust',
    needsArg: true,
  },
  {
    name: 'rollback',
    args: '<skill>',
    description: 'Restore the previous version from its snapshot',
    group: 'Trust',
    needsArg: true,
  },
  {
    name: 'verify',
    args: '[skill]',
    description: 'Re-hash installed files against the lock',
    group: 'Trust',
  },
  {
    name: 'doctor',
    description: 'Check agents, folders, the lock and approvals',
    group: 'Trust',
  },
  {
    name: 'agents',
    description: 'Choose the target agents (space toggles)',
    group: 'Session',
  },
  {
    name: 'scope',
    args: '[project|user]',
    description: 'Install into the project or your user folders',
    group: 'Session',
  },
  {
    name: 'registry',
    args: '[set <https://… | file:folder>]',
    description: 'Show or set the registry for this session',
    group: 'Session',
  },
  {
    name: 'theme',
    args: '[dark|light|mono]',
    description: 'Switch the color theme',
    group: 'Session',
  },
  { name: 'help', description: 'Keys, commands and environment', group: 'Session', aliases: ['?'] },
  {
    name: 'clear',
    description: 'Back to the home screen',
    group: 'Session',
    aliases: ['home', 'cls'],
  },
  { name: 'quit', description: 'Leave agenthub', group: 'Session', aliases: ['exit', 'q'] },
];

export interface CommandMatch {
  command: SlashCommand;
  score: number;
  /** Indices of matched characters in the command name (for highlighting). */
  positions: number[];
}

/**
 * Fuzzy score of `query` against `name`: prefix beats word start beats substring beats a
 * subsequence; null when the characters do not appear in order.
 */
export function fuzzyScore(
  query: string,
  name: string,
): { score: number; positions: number[] } | null {
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  if (q === '') return { score: 1, positions: [] };
  if (n.startsWith(q)) {
    return { score: 1000 - n.length, positions: [...Array(q.length).keys()] };
  }
  const at = n.indexOf(q);
  if (at !== -1) {
    return {
      score: 600 - at - n.length,
      positions: [...Array(q.length).keys()].map((i) => i + at),
    };
  }
  const positions: number[] = [];
  let from = 0;
  for (const char of q) {
    const index = n.indexOf(char, from);
    if (index === -1) return null;
    positions.push(index);
    from = index + 1;
  }
  const spread = (positions[positions.length - 1] ?? 0) - (positions[0] ?? 0);
  return { score: 300 - spread * 4 - (positions[0] ?? 0), positions };
}

/** Palette entries for what was typed after "/", best first. */
export function filterCommands(
  query: string,
  commands: readonly SlashCommand[] = COMMANDS,
): CommandMatch[] {
  const out: CommandMatch[] = [];
  for (const command of commands) {
    let best = fuzzyScore(query, command.name);
    for (const alias of command.aliases ?? []) {
      const viaAlias =
        alias.toLowerCase() === query.toLowerCase() ? { score: 900, positions: [] } : null;
      if (viaAlias !== null && (best === null || viaAlias.score > best.score)) best = viaAlias;
    }
    if (best === null && query.length >= 3) {
      // Fall back to the description ("approval" finds /approve, "check" finds /doctor).
      const words = command.description.toLowerCase();
      if (words.includes(query.toLowerCase())) best = { score: 100, positions: [] };
    }
    if (best !== null) out.push({ command, score: best.score, positions: best.positions });
  }
  // Stable: equal scores keep the palette order.
  return out
    .map((match, index) => ({ match, index }))
    .sort((a, b) => b.match.score - a.match.score || a.index - b.index)
    .map(({ match }) => match);
}

/** The command a typed name refers to: exact name, alias, or a unique prefix. */
export function resolveCommand(name: string): SlashCommand | null {
  const n = name.toLowerCase();
  const exact = COMMANDS.find((c) => c.name === n || (c.aliases ?? []).includes(n));
  if (exact !== undefined) return exact;
  const prefixed = COMMANDS.filter((c) => c.name.startsWith(n));
  return prefixed.length === 1 ? (prefixed[0] ?? null) : null;
}

export type ParsedInput =
  | { kind: 'empty' }
  | { kind: 'search'; query: string }
  | { kind: 'command'; name: string; command: SlashCommand | null; args: string[] };

export function parseInput(text: string): ParsedInput {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'empty' };
  if (!trimmed.startsWith('/')) return { kind: 'search', query: trimmed };
  const [head = '', ...args] = trimmed.slice(1).split(/\s+/);
  return { kind: 'command', name: head, command: resolveCommand(head), args };
}

/** True while the palette should be open: "/" followed by a command name being typed. */
export function paletteQuery(text: string): string | null {
  if (!text.startsWith('/')) return null;
  const rest = text.slice(1);
  return /\s/.test(rest) ? null : rest;
}
