/** The four supported agents, in display order. Mirrors AGENTS in src/lib/validation.ts. */
export const AGENT_IDS = ['claude-code', 'codex', 'cursor', 'vscode'] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export interface AgentMeta {
  /** Two-letter monogram shown on the tile. No vendor logos are used anywhere. */
  monogram: string;
  name: string;
}

export const AGENT_META: Record<AgentId, AgentMeta> = {
  'claude-code': { monogram: 'CC', name: 'Claude Code' },
  codex: { monogram: 'CX', name: 'Codex' },
  cursor: { monogram: 'CU', name: 'Cursor' },
  vscode: { monogram: 'VS', name: 'VS Code / Copilot' },
};
