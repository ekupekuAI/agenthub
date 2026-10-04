import { AGENT_IDS, type AgentHubError } from '@agenthub/core';
import { describe, expect, it } from 'vitest';
import {
  ADAPTERS,
  AGENT_PATHS,
  getAdapter,
  isAgentId,
  normalizeSkillsDir,
  PATH_TABLE_VERSION,
  WRITE_CANDIDATES,
} from '../src/index';

const SCOPES = ['project', 'user'] as const;

describe('path table', () => {
  it('has one verified, sourced row per agent', () => {
    expect(PATH_TABLE_VERSION).toBe('2026-09-28');
    for (const id of AGENT_IDS) {
      const entry = AGENT_PATHS[id];
      expect(entry.verifiedAt).toBe(PATH_TABLE_VERSION);
      expect(entry.sources.length).toBeGreaterThan(0);
      for (const source of entry.sources) expect(source).toMatch(/^https:\/\//);
      expect(entry.project.length).toBeGreaterThan(0);
      expect(entry.user.length).toBeGreaterThan(0);
    }
  });

  it('never offers a legacy codex folder as a write candidate', () => {
    for (const scope of SCOPES) {
      const legacy = AGENT_IDS.flatMap((id) => AGENT_PATHS[id].legacy?.[scope] ?? []);
      expect(legacy).toContain('.codex/skills');
      for (const dir of WRITE_CANDIDATES[scope]) {
        expect(legacy).not.toContain(dir);
        expect(dir.startsWith('.codex')).toBe(false);
      }
    }
  });

  it('lists write candidates in preference order', () => {
    expect(WRITE_CANDIDATES.project).toEqual([
      '.agents/skills',
      '.claude/skills',
      '.cursor/skills',
      '.github/skills',
    ]);
    expect(WRITE_CANDIDATES.user).toEqual([
      '.agents/skills',
      '.claude/skills',
      '.cursor/skills',
      '.copilot/skills',
    ]);
  });

  it('gives every adapter at least one write candidate it reads, per scope', () => {
    for (const adapter of ADAPTERS) {
      for (const scope of SCOPES) {
        const readable = WRITE_CANDIDATES[scope].filter((dir) => adapter.reads(scope, dir));
        expect(readable.length, `${adapter.id} at ${scope} scope`).toBeGreaterThan(0);
      }
    }
  });
});

describe('adapters', () => {
  it('are verified and listed in AGENT_IDS order', () => {
    expect(ADAPTERS.map((adapter) => adapter.id)).toEqual([...AGENT_IDS]);
    for (const adapter of ADAPTERS) {
      expect(adapter.status).toBe('verified');
      expect(adapter.paths).toBe(AGENT_PATHS[adapter.id]);
    }
  });

  it('carry the reload hints from design §7.4', () => {
    expect(getAdapter('claude-code').reloadHint).toContain('/reload-skills');
    expect(getAdapter('cursor').reloadHint).toContain('restart');
    expect(getAdapter('vscode').reloadHint).toContain('/skills reload');
    expect(getAdapter('codex').reloadHint).toBeUndefined();
  });

  it('reads() matches the table after normalizing the folder', () => {
    const claude = getAdapter('claude-code');
    expect(claude.reads('project', '.claude/skills')).toBe(true);
    expect(claude.reads('project', './.claude/skills/')).toBe(true);
    expect(claude.reads('project', '.claude\\skills')).toBe(true);
    expect(claude.reads('user', '~/.claude/skills')).toBe(true);
    expect(getAdapter('vscode').reads('user', '.copilot/skills')).toBe(true);
    expect(getAdapter('vscode').reads('project', '.github/skills')).toBe(true);
  });

  it('reads() rejects folders an agent does not read', () => {
    expect(getAdapter('claude-code').reads('project', '.agents/skills')).toBe(false);
    expect(getAdapter('codex').reads('project', '.claude/skills')).toBe(false);
    expect(getAdapter('codex').reads('user', '.codex/skills')).toBe(false);
    expect(getAdapter('vscode').reads('project', '.copilot/skills')).toBe(false);
    expect(getAdapter('vscode').reads('user', '.github/skills')).toBe(false);
    expect(getAdapter('claude-code').reads('project', '.Claude/skills')).toBe(false);
  });

  it('getAdapter() throws USAGE for an unknown id', () => {
    expect(isAgentId('cursor')).toBe(true);
    expect(isAgentId('windsurf')).toBe(false);
    try {
      getAdapter('windsurf' as never);
      expect.unreachable();
    } catch (error) {
      expect((error as AgentHubError).code).toBe('USAGE');
    }
  });

  it('normalizeSkillsDir keeps project paths relative and strips ~/ only at user scope', () => {
    expect(normalizeSkillsDir('user', '~/.agents//skills/')).toBe('.agents/skills');
    expect(normalizeSkillsDir('project', '~/.agents/skills')).toBe('~/.agents/skills');
  });
});
