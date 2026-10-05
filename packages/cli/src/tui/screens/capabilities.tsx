/**
 * Capability inventories and deltas. The rows come from the classic formatter
 * (capability-format.ts, plain style) so the wording is identical in both modes; this file only
 * colors them: additions amber, removals dim, tightened pins lime.
 */
import type { CapabilityDelta, CapabilityReport, PlanCapabilities } from '@agenthub/core';
import { Box, Text } from 'ink';
import {
  approvalStateText,
  deltaLines,
  expansionCount,
  fileSummaryLine,
  INVENTORY_CAPTION,
  inventoryLines,
} from '../../capability-format';
import { createStyle } from '../../output';
import { Panel, T, type Tone } from '../components/primitives';
import { useTheme } from '../hooks/context';
import { safe } from '../sanitize';

const plain = createStyle(false);

export function InventoryRows({ report }: { report: CapabilityReport }) {
  const lines = inventoryLines(report, plain, '');
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => {
        const undeclared = line.endsWith('(observed, undeclared)');
        const marker = line.startsWith('marker');
        const text = undeclared ? line.slice(0, -'  (observed, undeclared)'.length) : line;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows may repeat
          <Text key={index}>
            <T tone={marker ? 'block' : 'text'}>{safe(text)}</T>
            {undeclared ? <T tone="warn"> observed, undeclared</T> : null}
          </Text>
        );
      })}
    </Box>
  );
}

function deltaTone(line: string): Tone {
  const mark = line.trimStart()[0];
  if (mark === '+' || mark === '~') return 'warn';
  if (mark === '=') return 'signal';
  return 'subtle';
}

export function DeltaRows({ delta }: { delta: CapabilityDelta }) {
  const lines = deltaLines(delta, plain, '');
  if (lines.length === 0) return <T tone="muted">no capability changes found by static analysis</T>;
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows may repeat
        <T key={index} tone={deltaTone(line)} bold={deltaTone(line) === 'warn'}>
          {safe(line)}
        </T>
      ))}
    </Box>
  );
}

/** The plan's capability block: inventory for a fresh install, the delta for a replace. */
export function PlanCapabilitiesCard({
  caps,
  name,
  version,
  previousVersion,
  sameDigest,
}: {
  caps: PlanCapabilities;
  name: string;
  version: string;
  previousVersion?: string;
  sameDigest: boolean;
}) {
  const theme = useTheme();
  const g = theme.glyphs;
  if (caps.delta === null) {
    return (
      <Panel title="Capabilities" aside={<T tone="subtle">{INVENTORY_CAPTION}</T>}>
        <InventoryRows report={caps.candidate} />
        {!caps.approvable ? (
          <T tone="warn">no approval is recorded while the policy outcome is block</T>
        ) : null}
      </Panel>
    );
  }
  if (sameDigest) {
    return (
      <Panel title="Capabilities">
        <T tone="muted">{`unchanged (the same files as installed) — approval: ${approvalStateText(caps.state)}`}</T>
        {caps.stale.length > 0 ? (
          <T tone="warn">{`the current scanner rules also see: ${caps.stale.map(safe).join(', ')}`}</T>
        ) : null}
      </Panel>
    );
  }
  const expansion = caps.approvalRequired;
  const count = expansionCount(caps.unapproved);
  const shown = new Set(caps.delta.reasons);
  const extra = caps.unapproved.reasons.filter((reason) => !shown.has(reason));
  return (
    <Panel
      title={expansion ? 'New capabilities' : 'Capabilities'}
      tone={expansion ? 'warn' : undefined}
      aside={
        <T tone={expansion ? 'warn' : 'subtle'}>
          {`${safe(name)} ${previousVersion === undefined ? '' : `${safe(previousVersion)} ${g.arrow} `}${safe(version)}`}
        </T>
      }
    >
      <DeltaRows delta={caps.delta} />
      {caps.files === null ? null : <T tone="muted">{fileSummaryLine(caps.files)}</T>}
      {expansion && extra.length > 0 ? (
        <T tone="warn">{`not approved before: ${extra.map(safe).join(', ')}`}</T>
      ) : null}
      {expansion ? (
        <Box marginTop={1}>
          <T tone="warn" bold>
            {caps.state === 'approved' ||
            caps.state === 'approved-carried' ||
            caps.state === 'stale'
              ? `${g.warn} This update can do more than the version you approved (${count} new).`
              : `${g.warn} The installed version has no capability approval (${approvalStateText(caps.state)}), so this inventory needs one.`}
          </T>
        </Box>
      ) : caps.state !== 'fresh' ? (
        <T tone="subtle">{`approval: ${approvalStateText(caps.state)}; nothing new to approve`}</T>
      ) : null}
      <T tone="subtle">{INVENTORY_CAPTION}</T>
    </Panel>
  );
}
