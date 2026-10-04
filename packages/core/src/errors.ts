export type ErrorCode =
  | 'USAGE'
  | 'VALIDATION'
  | 'POLICY_BLOCKED'
  | 'INTEGRITY'
  | 'DRIFT'
  | 'INCOMPATIBLE'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IO'
  | 'REGISTRY'
  | 'CANCELLED'
  | 'INTERNAL';

/** CLI exit codes (design §10). */
export const EXIT_CODES: Record<ErrorCode, number> = {
  USAGE: 2,
  VALIDATION: 1,
  POLICY_BLOCKED: 3,
  INTEGRITY: 4,
  DRIFT: 4,
  INCOMPATIBLE: 5,
  NOT_FOUND: 1,
  CONFLICT: 1,
  IO: 1,
  REGISTRY: 1,
  CANCELLED: 130,
  INTERNAL: 1,
};

export class AgentHubError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AgentHubError';
    this.code = code;
    this.details = details;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}

export function isAgentHubError(error: unknown): error is AgentHubError {
  return error instanceof AgentHubError;
}
