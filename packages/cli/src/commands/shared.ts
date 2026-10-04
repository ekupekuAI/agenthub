import { AgentHubError } from '@agenthub/core';

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function assertSkillName(name: string): void {
  if (!NAME.test(name) || name.length > 64) {
    throw new AgentHubError(
      'USAGE',
      `invalid skill name "${name}" (lowercase letters, digits and single hyphens)`,
    );
  }
}
