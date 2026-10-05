import { cn } from '../../lib/cn';
import { AGENT_IDS, AGENT_META, type AgentId, FolderIcon } from '../ui';

const FOLDERS: readonly { path: string; readers: readonly AgentId[] }[] = [
  { path: '.claude/skills', readers: ['claude-code', 'cursor', 'vscode'] },
  { path: '.agents/skills', readers: ['codex', 'cursor', 'vscode'] },
];

/**
 * Which agent reads which skill folder, drawn as a small map: two folders, four agents, and a
 * mark where an agent reads a folder. It is a table underneath, so the mapping is announced.
 */
export function AgentFolders() {
  return (
    <figure className="my-6">
      <div className="overflow-hidden rounded-card border border-border bg-surface-1 shadow-panel">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">Skill folders each agent reads</caption>
          <thead>
            <tr className="border-border border-b">
              <th scope="col" className="px-4 py-3 align-bottom">
                <span className="eyebrow">Agent</span>
              </th>
              {FOLDERS.map((folder) => (
                <th
                  key={folder.path}
                  scope="col"
                  className="w-[34%] border-border border-l px-3 py-3 align-bottom sm:w-[30%] sm:px-4"
                >
                  <span className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
                    <FolderIcon size={15} className="shrink-0 text-subtle" />
                    <code className="border-0 bg-transparent p-0 font-mono text-[0.8125rem] text-text">
                      {folder.path.split('/').map((part, index) => (
                        <span key={part}>
                          {index > 0 ? (
                            <>
                              /<wbr />
                            </>
                          ) : null}
                          {part}
                        </span>
                      ))}
                    </code>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {AGENT_IDS.map((agent) => {
              const both = FOLDERS.every((folder) => folder.readers.includes(agent));
              return (
                <tr key={agent} className="border-border border-b last:border-b-0">
                  <th scope="row" className="px-4 py-3 font-normal">
                    <span className="flex items-center gap-3">
                      <span
                        aria-hidden="true"
                        className="inline-flex h-7 w-8 shrink-0 items-center justify-center rounded-chip border border-border-strong bg-surface-2 font-mono text-[0.6875rem] text-text"
                      >
                        {AGENT_META[agent].monogram}
                      </span>
                      <span className="min-w-0 text-small text-text">
                        {AGENT_META[agent].name}
                        {both ? (
                          <span className="block text-[0.75rem] text-muted leading-4">
                            reads both
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </th>
                  {FOLDERS.map((folder) => {
                    const reads = folder.readers.includes(agent);
                    return (
                      <td
                        key={folder.path}
                        className="border-border border-l px-3 py-3 align-middle sm:px-4"
                      >
                        <span
                          className={cn(
                            'inline-flex items-center gap-2 font-mono text-[0.75rem]',
                            reads ? 'text-signal-ink' : 'text-subtle',
                          )}
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              'size-2 rounded-full',
                              reads ? 'bg-signal' : 'border border-border-strong',
                            )}
                          />
                          {reads ? 'reads' : 'no'}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <figcaption className="mt-2 pl-1 text-[0.8125rem] text-muted leading-5">
        Installing for all four agents writes two identical copies, one per folder.
      </figcaption>
    </figure>
  );
}
