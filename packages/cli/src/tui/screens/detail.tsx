/**
 * Skill detail: the trust receipt (digests, scanner, verdict stamp), declared permissions,
 * the capability inventory, findings grouped BLOCK / WARN / INFO and requirements.
 */
import type { EvaluatedFinding, SkillInfoVersion } from '@agenthub/core';
import { Box, Text } from 'ink';
import { INVENTORY_CAPTION } from '../../capability-format';
import { formatBytes, shortDigest } from '../../format';
import { AgentIds, ApprovalWord, outcomeTone, Stamp, VerdictBadge } from '../components/badges';
import { FindingRow } from '../components/cards';
import { Field, Panel, T } from '../components/primitives';
import { useApp, useKeys, useTheme } from '../hooks/context';
import { useReveal } from '../hooks/motion';
import { useTask } from '../hooks/task';
import { safe } from '../sanitize';
import type { SkillDetail } from '../session';
import { InventoryRows } from './capabilities';
import { Footer, Scroll, split, TaskView } from './common';

export function DetailScreen({ name }: { name: string }) {
  const app = useApp();
  const [state] = useTask(() => app.session.detail(name), [name]);
  return (
    <Box flexDirection="column" paddingX={1}>
      <TaskView
        state={state}
        loading={`Reading ${safe(name)} from the registry`}
        what={`Could not read ${safe(name)}`}
      >
        {(detail) => <Detail detail={detail} />}
      </TaskView>
    </Box>
  );
}

function permissionRows(version: SkillInfoVersion): [string, string][] {
  const p = version.permissions;
  if (p === undefined) return [];
  const rows: [string, string][] = [];
  if (p.network !== undefined) {
    rows.push([
      'network',
      Array.isArray(p.network) ? p.network.map(safe).join(', ') : p.network ? 'any host' : 'none',
    ]);
  }
  if (p.exec?.length) rows.push(['exec', p.exec.map(safe).join(', ')]);
  if (p.env?.length) rows.push(['env', p.env.map(safe).join(', ')]);
  if (p.secrets?.length) rows.push(['secrets', p.secrets.map(safe).join(', ')]);
  if (p.fs?.write?.length) rows.push(['fs write', p.fs.write.map(safe).join(', ')]);
  return rows;
}

function Findings({ findings }: { findings: EvaluatedFinding[] }) {
  const theme = useTheme();
  const groups: EvaluatedFinding['decision'][] = ['BLOCK', 'WARN', 'INFO'];
  if (findings.length === 0) {
    return (
      <T tone="muted">
        No findings. The scanner reports what it finds; it does not certify safety.
      </T>
    );
  }
  return (
    <Box flexDirection="column">
      <Text>
        {groups.map((decision, index) => {
          const count = findings.filter((f) => f.decision === decision).length;
          const tone = decision === 'BLOCK' ? 'block' : decision === 'WARN' ? 'warn' : 'info';
          return (
            <Text key={decision}>
              {index === 0 ? '' : <T tone="subtle">{`  ${theme.glyphs.sep}  `}</T>}
              <T tone={count === 0 ? 'subtle' : tone} bold={count > 0}>{`${count} ${decision}`}</T>
            </Text>
          );
        })}
      </Text>
      {groups.map((decision) =>
        findings
          .filter((f) => f.decision === decision)
          .slice(0, 12)
          .map((finding) => (
            <Box
              key={`${decision}:${finding.ruleId}:${finding.file}:${finding.line}`}
              marginTop={1}
            >
              <FindingRow finding={finding} />
            </Box>
          )),
      )}
    </Box>
  );
}

function Receipt({
  detail,
  version,
  wide,
}: {
  detail: SkillDetail;
  version: SkillInfoVersion;
  wide: boolean;
}) {
  const theme = useTheme();
  const g = theme.glyphs;
  const outcome = version.scan?.outcome;
  const word =
    outcome === 'allow'
      ? 'allow'
      : outcome === 'confirm'
        ? 'warn'
        : outcome === 'block'
          ? 'block'
          : 'unscanned';
  const glyph =
    outcome === 'allow'
      ? g.ok
      : outcome === 'confirm'
        ? g.warn
        : outcome === 'block'
          ? g.block
          : g.pending;
  return (
    <Panel title="Trust receipt" tone={outcome === 'block' ? 'block' : undefined} {...split(wide)}>
      <Box marginY={1}>
        <Stamp tone={outcomeTone(outcome)} glyph={glyph} word={word} />
        <T tone="subtle">
          {version.scan === undefined
            ? '  no scan published'
            : `  scanner ${safe(version.scan.scannerVersion)}`}
        </T>
      </Box>
      <Field name="version">
        <T tone="text" bold>
          {safe(version.version)}
        </T>
        <T tone="muted">{`  ${safe(version.status)}${version.channel === 'beta' ? ' · beta' : ''}`}</T>
      </Field>
      <Field name="digest">
        <T tone="info">{shortDigest(version.digest)}</T>
      </Field>
      {version.archiveDigest ? (
        <Field name="archive">
          <T tone="info">{shortDigest(version.archiveDigest)}</T>
        </Field>
      ) : null}
      {version.capabilities ? (
        <Field name="caps">
          <T tone="info">{shortDigest(version.capabilities.digest)}</T>
        </Field>
      ) : null}
      {version.sizeBytes === undefined ? null : (
        <Field name="size">
          <T tone="text">{formatBytes(version.sizeBytes)}</T>
          {version.skillMdLines === undefined ? null : (
            <T tone="muted">{`  ${g.sep}  SKILL.md ${version.skillMdLines} lines`}</T>
          )}
        </Field>
      )}
      {version.agents === undefined ? null : (
        <Field name="agents">
          <AgentIds ids={version.agents} />
        </Field>
      )}
      <Field name="registry">
        <T tone="muted">{safe(detail.registry)}</T>
      </Field>
      {version.status === 'revoked' && version.revokedReason ? (
        <Box marginTop={1}>
          <T tone="block">{`${g.block} revoked: ${safe(version.revokedReason)}`}</T>
        </Box>
      ) : null}
    </Panel>
  );
}

function Detail({ detail }: { detail: SkillDetail }) {
  const app = useApp();
  const theme = useTheme();
  const g = theme.glyphs;
  const { info } = detail;
  const latest = info.latest;
  const installed = detail.installed[0];
  const wide = app.columns >= 110;
  const sections = useReveal(4, { interval: 70 });

  useKeys((input, key) => {
    if (key.return) {
      app.navigate({ kind: 'install', target: info.slug });
      return true;
    }
    if (input === 'd' && installed !== undefined) {
      app.navigate({ kind: 'diff', name: info.slug });
      return true;
    }
    if (input === 'u' && installed !== undefined) {
      app.navigate({ kind: 'update-flow', name: info.slug });
      return true;
    }
    if (input === 'a' && installed !== undefined) {
      app.navigate({ kind: 'approve', name: info.slug });
      return true;
    }
    return false;
  });

  const permissions = latest === null ? [] : permissionRows(latest);
  const requirements = latest?.requirements ?? [];
  const right = (
    <Box flexDirection="column" {...split(wide)}>
      {sections >= 2 ? (
        <Panel title="Declared permissions">
          {permissions.length === 0 ? <T tone="muted">none declared</T> : null}
          {permissions.map(([key, value]) => (
            <Field key={key} name={key}>
              <T tone="text">{value}</T>
            </Field>
          ))}
        </Panel>
      ) : null}
      {sections >= 3 && latest?.capabilities ? (
        <Panel title="Capabilities" aside={<T tone="subtle">reported by the registry</T>}>
          <InventoryRows
            report={{
              set: latest.capabilities.set,
              digest: latest.capabilities.digest,
              rulesetDigest: latest.capabilities.rulesetDigest,
              undeclared: latest.capabilities.undeclared,
              unobserved: latest.capabilities.unobserved,
            }}
          />
          <T tone="subtle">{`${INVENTORY_CAPTION}; recomputed locally at install`}</T>
        </Panel>
      ) : null}
      {sections >= 3 ? (
        <Panel title="Requirements">
          {requirements.length === 0 ? <T tone="muted">none declared</T> : null}
          {requirements.map((req) => (
            <Text key={`${req.kind}:${req.name}`}>
              <T tone="subtle">{`${req.kind.padEnd(8)} `}</T>
              <T tone="text">{safe(req.name)}</T>
              <T tone="muted">{req.constraint ? ` ${safe(req.constraint)}` : ''}</T>
            </Text>
          ))}
        </Panel>
      ) : null}
    </Box>
  );

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text>
          <T tone="signal" bold>
            {safe(info.name)}
          </T>
          <T tone="muted">{latest === null ? '' : `  ${safe(latest.version)}`}</T>
          <T tone="subtle">{info.category ? `  ${g.sep}  ${safe(info.category)}` : ''}</T>
        </Text>
        <Text>
          <VerdictBadge outcome={latest?.scan?.outcome} />
          {info.publisher === undefined ? null : (
            <Text>
              <T tone="subtle">{`  ${g.sep}  ${safe(info.publisher.name)}`}</T>
              {info.publisher.verified ? <T tone="signal">{` ${g.ok} verified`}</T> : null}
            </Text>
          )}
        </Text>
      </Box>
      {info.summary ? <T tone="muted">{safe(info.summary)}</T> : null}
      {installed === undefined ? (
        <T tone="subtle">not installed</T>
      ) : (
        <Text>
          <T tone="subtle">installed </T>
          <T tone="text">{`${safe(installed.version)} (${installed.scope})`}</T>
          <T tone="subtle">{`  ${g.sep}  `}</T>
          <ApprovalWord approval={installed.approval} />
        </Text>
      )}
      <Box marginTop={1} flexDirection="column">
        <Scroll height={Math.max(6, app.rows - 7)}>
          {latest === null ? (
            <T tone="warn">{`${g.warn} The registry lists no installable version.`}</T>
          ) : (
            <Box flexDirection="column">
              <Box flexDirection={wide ? 'row' : 'column'} gap={wide ? 1 : 0}>
                {sections >= 1 ? <Receipt detail={detail} version={latest} wide={wide} /> : null}
                {right}
              </Box>
              {sections >= 4 ? (
                <Panel
                  title="Findings"
                  aside={latest.scan ? <VerdictBadge outcome={latest.scan.outcome} /> : undefined}
                >
                  {latest.scan === undefined ? (
                    <T tone="muted">no scan published (agenthub scans locally before installing)</T>
                  ) : (
                    <Findings findings={latest.scan.findings} />
                  )}
                </Panel>
              ) : null}
              {sections >= 4 && info.versions.length > 1 ? (
                <Panel title="Versions">
                  {info.versions.slice(0, 8).map((v) => (
                    <Text key={v.version}>
                      <T tone="text">{safe(v.version).padEnd(12)}</T>
                      <T tone={v.status === 'active' ? 'muted' : 'block'}>
                        {safe(v.status).padEnd(12)}
                      </T>
                      <T tone="subtle">{(v.channel ?? 'stable').padEnd(8)}</T>
                      <T tone="info">{shortDigest(v.digest)}</T>
                    </Text>
                  ))}
                </Panel>
              ) : null}
            </Box>
          )}
        </Scroll>
      </Box>
      <Footer
        hints={[
          ['enter', 'install'],
          ...(installed === undefined
            ? []
            : ([
                ['d', 'diff'],
                ['u', 'update'],
                ['a', 'approve'],
              ] as const)),
          [`${g.up}${g.down}`, 'scroll'],
          ['esc', 'back'],
        ]}
      />
    </Box>
  );
}
