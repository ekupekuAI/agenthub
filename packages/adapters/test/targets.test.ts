import { type AgentHubError, type AgentId, isAgentHubError, type Scope } from '@agenthub/core';
import { describe, expect, it } from 'vitest';
import { duplicateAgents, foldersReadBy, selectTargetFolders } from '../src/index';

const ALL: AgentId[] = ['claude-code', 'codex', 'cursor', 'vscode'];

const COVER_CASES: Array<{ agents: AgentId[]; dirs: string[]; duplicates: AgentId[] }> = [
  { agents: ['claude-code', 'cursor', 'vscode'], dirs: ['.claude/skills'], duplicates: [] },
  { agents: ['codex', 'cursor', 'vscode'], dirs: ['.agents/skills'], duplicates: [] },
  { agents: ['cursor'], dirs: ['.agents/skills'], duplicates: [] },
  { agents: ['claude-code'], dirs: ['.claude/skills'], duplicates: [] },
  { agents: ['vscode'], dirs: ['.agents/skills'], duplicates: [] },
  { agents: ['codex'], dirs: ['.agents/skills'], duplicates: [] },
  { agents: ['claude-code', 'codex'], dirs: ['.agents/skills', '.claude/skills'], duplicates: [] },
  { agents: ALL, dirs: ['.agents/skills', '.claude/skills'], duplicates: ['cursor', 'vscode'] },
];

describe.each(['project', 'user'] as Scope[])('selectTargetFolders (%s scope)', (scope) => {
  it.each(COVER_CASES)('$agents -> $dirs', ({ agents, dirs, duplicates }) => {
    const folders = selectTargetFolders(scope, agents);
    expect(folders.map((folder) => folder.dir)).toEqual(dirs);
    expect(duplicateAgents(scope, folders)).toEqual(duplicates);
    // Every selected agent appears under at least one folder, and only selected agents appear.
    const listed = new Set(folders.flatMap((folder) => folder.agents));
    expect([...listed].sort()).toEqual([...agents].sort());
  });

  it('lists the selected agents that read each folder', () => {
    expect(selectTargetFolders(scope, ALL)).toEqual([
      { dir: '.agents/skills', agents: ['codex', 'cursor', 'vscode'] },
      { dir: '.claude/skills', agents: ['claude-code', 'cursor', 'vscode'] },
    ]);
  });

  it('ignores the order and repetition of the requested agents', () => {
    expect(selectTargetFolders(scope, ['vscode', 'cursor', 'vscode', 'claude-code'])).toEqual([
      { dir: '.claude/skills', agents: ['claude-code', 'cursor', 'vscode'] },
    ]);
  });

  it('returns [] for no agents', () => {
    expect(selectTargetFolders(scope, [])).toEqual([]);
    expect(duplicateAgents(scope, [])).toEqual([]);
  });

  it('throws INCOMPATIBLE when an agent reads none of the candidates', () => {
    let caught: unknown;
    try {
      selectTargetFolders(scope, ['claude-code', 'cursor'], ['.cursor/skills', '.agents/skills']);
    } catch (error) {
      caught = error;
    }
    expect(isAgentHubError(caught)).toBe(true);
    expect((caught as AgentHubError).code).toBe('INCOMPATIBLE');
    expect((caught as AgentHubError).message).toContain('claude-code');
    expect((caught as AgentHubError).details).toMatchObject({ agents: ['claude-code'] });
  });

  it('throws USAGE for an unknown agent id', () => {
    expect(() => selectTargetFolders(scope, ['windsurf' as AgentId])).toThrowError(/Unknown agent/);
  });
});

describe('smallest cover tie-break', () => {
  it('prefers the lexicographically smallest set of candidate indexes', () => {
    // cursor reads all of these; .cursor/skills is listed first here, so it wins the tie.
    expect(
      selectTargetFolders('project', ['cursor'], ['.cursor/skills', '.agents/skills']),
    ).toEqual([{ dir: '.cursor/skills', agents: ['cursor'] }]);
  });

  it('keeps candidate order in the output when only a pair of folders covers everyone', () => {
    const folders = selectTargetFolders(
      'project',
      ['claude-code', 'codex', 'vscode'],
      ['.github/skills', '.claude/skills', '.agents/skills'],
    );
    expect(folders.map((folder) => folder.dir)).toEqual(['.claude/skills', '.agents/skills']);
  });
});

describe('duplicateAgents', () => {
  it('reports agents that read more than one written folder', () => {
    const folders = [
      { dir: '.agents/skills', agents: ['cursor'] as AgentId[] },
      { dir: '.cursor/skills', agents: ['cursor'] as AgentId[] },
    ];
    expect(duplicateAgents('project', folders)).toEqual(['cursor']);
  });

  it('does not count the same folder twice', () => {
    const folders = [
      { dir: '.claude/skills', agents: ['claude-code'] as AgentId[] },
      { dir: './.claude/skills/', agents: ['claude-code'] as AgentId[] },
    ];
    expect(duplicateAgents('project', folders)).toEqual([]);
  });
});

describe('foldersReadBy', () => {
  it('returns the table row for the scope', () => {
    expect(foldersReadBy('vscode', 'project')).toEqual([
      '.github/skills',
      '.claude/skills',
      '.agents/skills',
    ]);
    expect(foldersReadBy('vscode', 'user')).toEqual([
      '.copilot/skills',
      '.claude/skills',
      '.agents/skills',
    ]);
    expect(foldersReadBy('codex', 'user')).toEqual(['.agents/skills']);
  });

  it('returns a copy that cannot change the table', () => {
    const dirs = foldersReadBy('claude-code', 'project');
    dirs.push('.evil/skills');
    expect(foldersReadBy('claude-code', 'project')).toEqual(['.claude/skills']);
  });
});
