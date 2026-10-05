'use server';

import { getAccounts, type TokenSummary } from '../../src/lib/accounts';
import {
  currentPublisher,
  guardOrigin,
  limitFailedAttempt,
  limitIdentity,
} from '../../src/lib/action-guard';
import { isApiError } from '../../src/lib/errors';
import { getRegistry, type PublisherSkillSummary } from '../../src/lib/registry';

export type DashboardState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      publisher: { name: string; verified: boolean };
      skills: PublisherSkillSummary[];
    };

export async function dashboardAction(
  _prev: DashboardState,
  formData: FormData,
): Promise<DashboardState> {
  const blocked = await guardOrigin();
  if (blocked) return { status: 'error', message: blocked };
  const token = formData.get('token');
  if (typeof token !== 'string' || token.trim() === '') {
    return { status: 'error', message: 'Enter your publisher token.' };
  }
  const registry = await getRegistry();
  const publisher = await registry.authenticatePublisher(token.trim());
  if (!publisher) {
    const limited = await limitFailedAttempt();
    return { status: 'error', message: limited ?? 'That publisher token is not valid.' };
  }
  const limited = limitIdentity('read', `publisher:${publisher.id}`);
  if (limited) return { status: 'error', message: limited };
  return {
    status: 'ready',
    publisher: { name: publisher.displayName, verified: publisher.verifiedAt !== null },
    skills: await registry.listPublisherSkills(publisher.id),
  };
}

export type TokensState = {
  tokens: TokenSummary[];
  /** A token just created: shown once, never again. */
  created?: { name: string; token: string };
  revoked?: string;
  error?: string;
};

/**
 * Create or revoke a CLI token of the signed-in publisher (`intent` = 'create' | 'revoke').
 * Session only: a token pasted on this page cannot manage tokens.
 */
export async function tokensAction(prev: TokensState, formData: FormData): Promise<TokensState> {
  const blocked = await guardOrigin();
  if (blocked) return { tokens: prev.tokens, error: blocked };
  const me = await currentPublisher();
  if (!me) return { tokens: [], error: 'Your session has ended. Sign in again.' };
  const limited = limitIdentity('admin', `publisher-tokens:${me.publisher.id}`);
  if (limited) return { tokens: prev.tokens, error: limited };
  const accounts = await getAccounts();
  const intent = formData.get('intent');
  try {
    if (intent === 'create') {
      const created = await accounts.createToken(me.publisher.id, formData.get('name'));
      return {
        tokens: await accounts.listTokens(me.publisher.id),
        created: { name: created.name, token: created.token },
      };
    }
    if (intent === 'revoke') {
      const id = formData.get('tokenId');
      const tokens = await accounts.listTokens(me.publisher.id);
      const name = tokens.find((t) => t.id === id)?.name;
      const ok = typeof id === 'string' && (await accounts.revokeToken(me.publisher.id, id));
      return {
        tokens: await accounts.listTokens(me.publisher.id),
        ...(ok ? { revoked: name ?? 'token' } : { error: 'That token was already revoked.' }),
      };
    }
    return { tokens: prev.tokens, error: 'Unknown request.' };
  } catch (error) {
    if (isApiError(error)) return { tokens: prev.tokens, error: error.message };
    console.error('[agenthub] token change failed:', error instanceof Error ? error.message : '');
    return { tokens: prev.tokens, error: 'The change failed because of a server error.' };
  }
}
