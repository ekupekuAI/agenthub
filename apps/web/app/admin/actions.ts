'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  currentAdminSession,
  guardOrigin,
  limitFailedAttempt,
  limitIdentity,
} from '../../src/lib/action-guard';
import {
  adminEnabled,
  createSession,
  sessionCookieName,
  sessionCookieOptions,
  verifyAdminToken,
} from '../../src/lib/auth';
import { isApiError } from '../../src/lib/errors';
import { getRegistry } from '../../src/lib/registry';
import {
  createPublisherSchema,
  reasonSchema,
  slugSchema,
  versionSchema,
} from '../../src/lib/validation';

export type LoginState = { error?: string };

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  if (!adminEnabled()) return { error: 'Admin is disabled on this registry.' };
  const blocked = await guardOrigin();
  if (blocked) return { error: blocked };
  const token = formData.get('token');
  if (typeof token !== 'string' || !verifyAdminToken(token)) {
    // Only failed attempts are limited, so nobody can lock the administrator out.
    const limited = await limitFailedAttempt();
    return { error: limited ?? 'That admin token is not valid.' };
  }
  const session = createSession();
  if (!session) return { error: 'Admin is disabled on this registry.' };
  (await cookies()).set(sessionCookieName(), session.value, sessionCookieOptions(session.expires));
  redirect('/admin');
}

export async function logoutAction(): Promise<void> {
  const blocked = await guardOrigin();
  if (!blocked) {
    // Sign the session out on the server too, so a copied cookie stops working.
    const session = await currentAdminSession();
    if (session) await (await getRegistry()).revokeAdminSession(session.nonce, session.expires);
    // Clear with the attributes the cookie was set with: browsers ignore a deletion of a
    // __Host- cookie that lacks Secure and Path=/.
    (await cookies()).set(sessionCookieName(), '', {
      ...sessionCookieOptions(new Date(0)),
      maxAge: 0,
    });
  }
  redirect('/admin');
}

/** Admin session plus the admin rate limit; an error message, or null when allowed. */
async function requireAdmin(): Promise<string | null> {
  const blocked = await guardOrigin();
  if (blocked) return blocked;
  if (!adminEnabled()) return 'Admin is disabled on this registry.';
  const session = await currentAdminSession();
  if (!session) return (await limitFailedAttempt()) ?? 'Your session has expired.';
  return limitIdentity('admin', 'admin-session');
}

const targetSchema = z.object({ slug: slugSchema, version: versionSchema });

type Op = 'approve' | 'quarantine' | 'revoke' | 'rescan';

async function moderate(op: Op, formData: FormData): Promise<never> {
  if (await requireAdmin()) redirect('/admin?error=unauthorized');

  const target = targetSchema.safeParse({
    slug: formData.get('slug'),
    version: formData.get('version'),
  });
  if (!target.success) redirect('/admin?error=invalid');
  const { slug, version } = target.data;

  let reason = '';
  if (op !== 'rescan') {
    const parsed = reasonSchema.safeParse(formData.get('reason') ?? '');
    if (!parsed.success) redirect('/admin?error=reason');
    reason = parsed.data;
  }

  let outcome = 'ok';
  try {
    const registry = await getRegistry();
    if (op === 'approve') await registry.setStatus(slug, version, 'active', reason);
    else if (op === 'quarantine') await registry.setStatus(slug, version, 'quarantined', reason);
    else if (op === 'revoke') await registry.revoke(slug, version, reason);
    else await registry.rescan(slug, version);
  } catch (error) {
    outcome = isApiError(error) && error.code === 'CONFLICT' ? 'conflict' : 'failed';
    if (!isApiError(error)) {
      console.error(
        '[agenthub] moderation failed:',
        error instanceof Error ? error.message : error,
      );
    }
  }
  const params = new URLSearchParams({ done: op, target: `${slug}@${version}`, result: outcome });
  redirect(`/admin?${params.toString()}`);
}

export async function approveAction(formData: FormData) {
  await moderate('approve', formData);
}
export async function quarantineAction(formData: FormData) {
  await moderate('quarantine', formData);
}
export async function revokeAction(formData: FormData) {
  await moderate('revoke', formData);
}
export async function rescanAction(formData: FormData) {
  await moderate('rescan', formData);
}

export type CreatePublisherState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'created'; displayName: string; verified: boolean; token: string };

export async function createPublisherAction(
  _prev: CreatePublisherState,
  formData: FormData,
): Promise<CreatePublisherState> {
  const blocked = await requireAdmin();
  if (blocked) return { status: 'error', message: blocked };
  const parsed = createPublisherSchema.safeParse({
    displayName: formData.get('displayName'),
    verified: formData.get('verified') === 'on',
  });
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }
  try {
    const registry = await getRegistry();
    const created = await registry.createPublisher(parsed.data.displayName, parsed.data.verified);
    return {
      status: 'created',
      displayName: created.displayName,
      verified: created.verified,
      token: created.token,
    };
  } catch (error) {
    if (isApiError(error)) return { status: 'error', message: error.message };
    return { status: 'error', message: 'Could not create the publisher.' };
  }
}
