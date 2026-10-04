import { describe, expect, it } from 'vitest';
import { parseManifest, validateManifest } from '../src/index';
import { catchError, issueCodes, issuesOf, VALID_MANIFEST } from './helpers';

function rejects(text: string): { codes: string[]; messages: string[]; paths: string[] } {
  const error = catchError(() => parseManifest(text));
  expect(error.code).toBe('VALIDATION');
  const issues = issuesOf(error);
  expect(issues.length).toBeGreaterThan(0);
  return {
    codes: issueCodes(error),
    messages: issues.map((issue) => issue.message),
    paths: issues.map((issue) => issue.path ?? ''),
  };
}

describe('parseManifest', () => {
  it('parses the design §5.2 example', () => {
    expect(parseManifest(VALID_MANIFEST)).toEqual({
      schema: 1,
      version: '1.3.0',
      targets: ['claude-code', 'cursor'],
      requires: {
        runtimes: { node: '>=22', python: '>=3.10' },
        commands: ['git', 'npx'],
        mcp: ['playwright'],
      },
      permissions: {
        network: true,
        exec: ['npx', 'node'],
        env: ['PLAYWRIGHT_BROWSERS_PATH'],
        secrets: [],
        fs: { write: ['project', 'temp'] },
      },
      channel: 'stable',
    });
  });

  it('accepts the minimal manifest and a host list for network', () => {
    expect(parseManifest('schema: 1\nversion: 0.1.0-beta.1\n')).toEqual({
      schema: 1,
      version: '0.1.0-beta.1',
    });
    const manifest = parseManifest(
      'schema: 1\nversion: 1.0.0\npermissions:\n  network: [api.example.com, "*.github.com", 10.0.0.1]\n',
    );
    expect(manifest.permissions?.network).toEqual(['api.example.com', '*.github.com', '10.0.0.1']);
  });

  it('strips a BOM', () => {
    expect(parseManifest('﻿schema: 1\nversion: 1.0.0\n').version).toBe('1.0.0');
  });

  it('rejects unknown top-level keys', () => {
    const result = rejects('schema: 1\nversion: 1.0.0\nverison: 1.0.0\n');
    expect(result.codes).toEqual(['manifest.unrecognized_keys']);
    expect(result.messages[0]).toMatch(/verison/);
  });

  it('rejects unknown nested keys with a readable path', () => {
    const result = rejects('schema: 1\nversion: 1.0.0\npermissions:\n  netwrok: true\n');
    expect(result.codes).toEqual(['manifest.unrecognized_keys']);
    expect(result.paths).toEqual(['permissions']);
    expect(result.messages[0]).toMatch(/^permissions: .*netwrok/);
  });

  it.each([
    ['not semver', 'version: banana'],
    ['two-part number', 'version: 1.2'],
    ['two-part string', 'version: "1.2"'],
    ['v-prefixed', 'version: v1.2.3'],
    ['missing', ''],
  ])('rejects a bad version (%s)', (_label, line) => {
    const result = rejects(`schema: 1\n${line}\n`);
    expect(result.paths).toContain('version');
  });

  it('rejects a bad runtime range', () => {
    const result = rejects(
      'schema: 1\nversion: 1.0.0\nrequires:\n  runtimes:\n    node: "not a range"\n',
    );
    expect(result.paths).toEqual(['requires.runtimes.node']);
    expect(result.messages[0]).toMatch(/semver range/);
  });

  it('rejects an empty runtime range', () => {
    const result = rejects('schema: 1\nversion: 1.0.0\nrequires:\n  runtimes: { node: "" }\n');
    expect(result.paths).toEqual(['requires.runtimes.node']);
  });

  it('rejects an unknown target', () => {
    const result = rejects('schema: 1\nversion: 1.0.0\ntargets: [claude-code, windsurf]\n');
    expect(result.paths).toEqual(['targets[1]']);
  });

  it.each([
    ['schema 2', 'schema: 2\nversion: 1.0.0', 'schema'],
    [
      'bad command',
      'schema: 1\nversion: 1.0.0\nrequires:\n  commands: ["rm -rf"]',
      'requires.commands[0]',
    ],
    ['bad exec', 'schema: 1\nversion: 1.0.0\npermissions:\n  exec: ["a;b"]', 'permissions.exec[0]'],
    ['bad env', 'schema: 1\nversion: 1.0.0\npermissions:\n  env: ["1BAD"]', 'permissions.env[0]'],
    [
      'bad host',
      'schema: 1\nversion: 1.0.0\npermissions:\n  network: ["https://x.com"]',
      'permissions.network[0]',
    ],
    [
      'bad network',
      'schema: 1\nversion: 1.0.0\npermissions:\n  network: yes-please',
      'permissions.network',
    ],
    [
      'bad fs scope',
      'schema: 1\nversion: 1.0.0\npermissions:\n  fs: { write: [root] }',
      'permissions.fs.write[0]',
    ],
    ['bad channel', 'schema: 1\nversion: 1.0.0\nchannel: nightly', 'channel'],
  ])('rejects %s', (_label, text, path) => {
    expect(rejects(text).paths[0]).toBe(path);
  });

  it('rejects text that is not a YAML mapping', () => {
    expect(rejects('- a\n- b\n').codes).toEqual(['manifest.type']);
    expect(rejects('').codes).toEqual(['manifest.type']);
  });

  it('rejects invalid YAML and duplicate keys', () => {
    expect(rejects('schema: [1\n').codes).toEqual(['manifest.yaml']);
    expect(rejects('schema: 1\nschema: 1\nversion: 1.0.0\n').codes).toEqual(['manifest.yaml']);
  });

  it('reports every problem at once', () => {
    const result = rejects('schema: 3\nversion: x\nextra: 1\n');
    expect(result.codes).toHaveLength(3);
  });
});

describe('validateManifest', () => {
  it('returns ok for valid data and issues for invalid data', () => {
    expect(validateManifest({ schema: 1, version: '2.0.0' })).toEqual({
      ok: true,
      manifest: { schema: 1, version: '2.0.0' },
    });
    const bad = validateManifest({ schema: 1 });
    expect(bad.ok).toBe(false);
  });
});
