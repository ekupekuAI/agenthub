'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { guardAction, hasAdminSession } from '../../src/lib/action-guard';
import {
  adminEnabled,
  createSession,
  sessionCookieName,
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
  const blocked = await guardAction('admin');
  if (blocked) return { error: blocked };
  const token = formData.get('token');
  if (typeof token !== 'string' || !verifyAdminToken(token)) {
    return { error: 'That admin token is not valid.' };
  }
  const session = createSession();
  if (!session) return { error: 'Admin is disabled on this registry.' };
  (await cookies()).set(sessionCookieName(), session.value, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: session.expires,
  });
  redirect('/admin');
}

export async function logoutAction(): Promise<void> {
  const blocked = await guardAction('admin');
  if (!blocked) (await cookies()).delete(sessionCookieName());
  redirect('/admin');
}

const targetSchema = z.object({ slug: slugSchema, version: versionSchema });

type Op = 'approve' | 'quarantine' | 'revoke' | 'rescan';

async function moderate(op: Op, formData: FormData): Promise<never> {
  const blocked = await guardAction('admin');
  if (blocked || !(await hasAdminSession())) redirect('/admin?error=unauthorized');

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
  const blocked = await guardAction('admin');
  if (blocked) return { status: 'error', message: blocked };
  if (!(await hasAdminSession())) return { status: 'error', message: 'Your session has expired.' };
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
