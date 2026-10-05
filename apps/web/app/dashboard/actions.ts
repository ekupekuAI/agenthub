'use server';

import { guardOrigin, limitFailedAttempt, limitIdentity } from '../../src/lib/action-guard';
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
