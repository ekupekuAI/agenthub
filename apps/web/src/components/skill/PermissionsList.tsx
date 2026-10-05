import type { SkillInfoVersion } from '../../lib/api-types';
import { keyed } from '../../lib/keys';
import { CircleDashedIcon, ReceiptRow } from '../ui';

type Permissions = NonNullable<SkillInfoVersion['permissions']>;

interface PermissionGroup {
  label: string;
  values: string[];
  /** Tooltip per value, for vocabulary that needs a gloss. */
  hints?: Record<string, string>;
}

const WRITE_SCOPE_HINTS: Record<string, string> = {
  project: 'The project folder the skill is used in',
  home: 'Your home directory',
  temp: 'The system temporary folder',
};

const ANY_HOST = 'any host';

/** The five declarable permission groups of agenthub.yaml, in the order they are shown. */
function groupsOf(permissions: Permissions): PermissionGroup[] {
  const network =
    permissions.network === true
      ? [ANY_HOST]
      : Array.isArray(permissions.network)
        ? permissions.network
        : [];
  return [
    {
      label: 'Network hosts',
      values: network,
      hints: { [ANY_HOST]: 'The skill declares network access without listing hosts' },
    },
    { label: 'Programs', values: permissions.exec ?? [] },
    { label: 'Env vars', values: permissions.env ?? [] },
    { label: 'Secrets', values: permissions.secrets ?? [] },
    { label: 'Write scopes', values: permissions.fs?.write ?? [], hints: WRITE_SCOPE_HINTS },
  ];
}

export interface PermissionsListProps {
  /** `permissions` of agenthub.yaml. Empty or missing when nothing is declared. */
  permissions?: SkillInfoVersion['permissions'];
  /** False when the version ships without an agenthub.yaml, so it cannot declare anything. */
  hasManifest?: boolean;
}

/**
 * What the version declares it needs: network hosts, programs, environment variables,
 * secrets and write scopes. Written for the footer of the trust receipt. Every value comes
 * from the publisher's manifest and is rendered as text.
 */
export function PermissionsList({ permissions, hasManifest = true }: PermissionsListProps) {
  const groups = groupsOf(permissions ?? {});
  const nothingDeclared = groups.every((group) => group.values.length === 0);

  return (
    <div>
      <h3 className="eyebrow">Declared permissions</h3>
      {nothingDeclared ? (
        <div className="mt-3 flex gap-2.5">
          <CircleDashedIcon size={16} className="mt-[0.2rem] text-subtle" />
          <div className="min-w-0">
            <p className="font-medium text-small text-text">Nothing declared</p>
            <p className="mt-0.5 text-muted text-small">
              {hasManifest
                ? 'No network, program, environment, secret or file-write access is declared.'
                : 'This version has no agenthub.yaml, so it declares no network, program, environment, secret or file-write access.'}{' '}
              Any such behavior the scanner finds is reported as undeclared.
            </p>
          </div>
        </div>
      ) : (
        <>
          <dl className="m-0 mt-2">
            {groups.map((group) => (
              <ReceiptRow key={group.label} label={group.label}>
                {group.values.length === 0 ? (
                  <span className="text-subtle">none</span>
                ) : (
                  keyed(group.values, (value) => value).map(({ item, key }) => (
                    <span
                      key={key}
                      title={group.hints?.[item]}
                      className="inline-block max-w-full break-all rounded-chip border border-border bg-surface-2 px-1.5 py-0.5 text-left text-[0.8125rem] text-text leading-5"
                    >
                      {item}
                    </span>
                  ))
                )}
              </ReceiptRow>
            ))}
          </dl>
          <p className="mt-3 text-[0.8125rem] text-subtle leading-5">
            Declared behavior downgrades matching findings. Undeclared behavior is flagged.
          </p>
        </>
      )}
    </div>
  );
}
