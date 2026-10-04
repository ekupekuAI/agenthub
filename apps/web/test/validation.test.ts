import { describe, expect, it } from 'vitest';
import { errorResponse } from '../src/lib/http';
import {
  resolveQuerySchema,
  revokeBodySchema,
  searchQuerySchema,
  slugSchema,
  versionSchema,
} from '../src/lib/validation';

describe('input validation', () => {
  it.each(['web-testing', 'a', 'sql2', 'x-1-y'])('accepts the slug %j', (slug) => {
    expect(slugSchema.safeParse(slug).success).toBe(true);
  });

  it.each(['Web-Testing', '-lead', 'trail-', 'double--dash', 'dot.name', '../etc', 'a b', '', 'é'])(
    'rejects the slug %j',
    (slug) => {
      expect(slugSchema.safeParse(slug).success).toBe(false);
    },
  );

  it.each(['1.0.0', '2.3.4-beta.1', '0.0.1'])('accepts the version %j', (v) => {
    expect(versionSchema.safeParse(v).success).toBe(true);
  });

  it.each(['1.0', 'v1.0.0', '1.0.0+build.5', 'latest', '01.0.0', '1.0.0 ', ''])(
    'rejects the version %j',
    (v) => {
      expect(versionSchema.safeParse(v).success).toBe(false);
    },
  );

  it('validates resolve queries', () => {
    expect(resolveQuerySchema.safeParse({ version: '^1.2.0', agent: 'cursor' }).success).toBe(true);
    expect(resolveQuerySchema.safeParse({ version: 'latest' }).success).toBe(true);
    expect(resolveQuerySchema.safeParse({ version: 'not a range!' }).success).toBe(false);
    expect(resolveQuerySchema.safeParse({ agent: 'emacs' }).success).toBe(false);
    expect(resolveQuerySchema.safeParse({ channel: 'nightly' }).success).toBe(false);
  });

  it('validates search queries', () => {
    expect(searchQuerySchema.parse({ q: '  web  ', limit: '5' })).toEqual({ q: 'web', limit: 5 });
    expect(searchQuerySchema.safeParse({ category: 'Bad Category' }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: 'x'.repeat(201) }).success).toBe(false);
  });

  it('requires a reason to revoke', () => {
    expect(revokeBodySchema.safeParse({ version: '1.0.0', reason: '' }).success).toBe(false);
    expect(revokeBodySchema.safeParse({ version: '1.0.0', reason: 'leaks tokens' }).success).toBe(
      true,
    );
  });

  it('turns validation failures into a 400 JSON error without internals', async () => {
    const parsed = slugSchema.safeParse('../etc');
    const res = errorResponse(parsed.error);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION');
    expect(JSON.stringify(body)).not.toMatch(/at .*\.ts/);
  });

  it('hides unexpected errors behind a generic 500', async () => {
    const res = errorResponse(new Error('secret internal detail at /srv/app.ts:12'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'Internal server error.' },
    });
  });
});
