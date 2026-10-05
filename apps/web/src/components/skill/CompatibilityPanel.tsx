import { AGENT_IDS, AGENT_META, type AgentId, AgentStrip, ReceiptRow } from '../ui';
import { RailPanel } from './RailPanel';

/**
 * Project-scope skills folders agenthub writes, and the agents that read each one.
 * Mirrors AGENT_PATHS and WRITE_CANDIDATES in packages/adapters/src/paths.ts.
 */
const FOLDER_READERS: readonly { dir: string; agents: readonly AgentId[] }[] = [
  { dir: '.agents/skills', agents: ['codex', 'cursor', 'vscode'] },
  { dir: '.claude/skills', agents: ['claude-code', 'cursor', 'vscode'] },
];

const LIST = new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' });

function names(ids: readonly AgentId[]): string {
  return LIST.format(ids.map((id) => AGENT_META[id].name));
}

export interface CompatibilityPanelProps {
  /** Agents the version supports. Empty when it lists none. */
  agents: readonly AgentId[];
  /** The author's free-text `compatibility` note from SKILL.md; untrusted text. */
  note?: string;
  className?: string;
}

/** Which agents the version supports, how it installs and which folders those agents read. */
export function CompatibilityPanel({ agents, note, className }: CompatibilityPanelProps) {
  const supported = AGENT_IDS.filter((id) => agents.includes(id));
  const missing = AGENT_IDS.filter((id) => !agents.includes(id));
  const folders = FOLDER_READERS.map((folder) => ({
    dir: folder.dir,
    agents: folder.agents.filter((id) => supported.includes(id)),
  })).filter((folder) => folder.agents.length > 0);

  return (
    <RailPanel
      id="compatibility"
      title="Compatibility"
      meta={`${supported.length} of ${AGENT_IDS.length} agents`}
      className={className}
    >
      <AgentStrip supported={supported} size="lg" label="Supported agents" />

      {supported.length === 0 ? (
        <p className="mt-3 text-muted text-small">
          This version does not list any supported agent.
        </p>
      ) : (
        <>
          <p className="mt-3 text-muted text-small">
            {missing.length === 0 ? 'Works with all four agents: ' : 'Works with '}
            <span className="text-text">{names(supported)}</span>.
            {missing.length > 0 ? ` Not listed for ${names(missing)}.` : null}
          </p>
          <dl className="m-0 mt-3 border-border border-t pt-2">
            <ReceiptRow label="Install mode">native</ReceiptRow>
            {folders.map((folder) => (
              <ReceiptRow key={folder.dir} label={folder.dir}>
                <span aria-hidden="true">
                  {folder.agents.map((id) => AGENT_META[id].monogram).join(' · ')}
                </span>
                <span className="sr-only">read by {names(folder.agents)}</span>
              </ReceiptRow>
            ))}
          </dl>
          <p className="mt-2 text-[0.8125rem] text-subtle leading-5">
            Native: the skill folder is installed as published. The CLI writes the fewest folders
            that reach the agents you use.
          </p>
        </>
      )}

      {note ? (
        <p className="mt-3 border-border border-t pt-3 text-muted text-small [overflow-wrap:anywhere]">
          <span className="font-medium text-text">Author note:</span> {note}
        </p>
      ) : null}
    </RailPanel>
  );
}
