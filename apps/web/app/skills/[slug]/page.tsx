import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache, type ReactNode } from 'react';
import { CompatibilityPanel } from '../../../src/components/skill/CompatibilityPanel';
import { FilesList } from '../../../src/components/skill/FilesList';
import { FindingsLedger } from '../../../src/components/skill/FindingsLedger';
import { LedgerSection } from '../../../src/components/skill/LedgerSection';
import { PermissionsList } from '../../../src/components/skill/PermissionsList';
import { ReadmePanel } from '../../../src/components/skill/ReadmePanel';
import { RequirementsPanel } from '../../../src/components/skill/RequirementsPanel';
import { SkillMasthead } from '../../../src/components/skill/SkillMasthead';
import { StatusBanner } from '../../../src/components/skill/StatusBanner';
import { StickyRail } from '../../../src/components/skill/StickyRail';
import { VersionsTable } from '../../../src/components/skill/VersionsTable';
import {
  ArrowDownIcon,
  Callout,
  Container,
  DecisionBadge,
  formatBytes,
  formatDate,
  ReceiptRow,
  Reveal,
  TrustReceipt,
} from '../../../src/components/ui';
import { isApiError } from '../../../src/lib/errors';
import { getRegistry, type SkillDetail } from '../../../src/lib/registry';
import { SLUG_RE } from '../../../src/lib/validation';

type Params = Promise<{ slug: string }>;

/** Cached per request, so metadata and the page share one registry read. */
const load = cache(async (slug: string): Promise<SkillDetail | null> => {
  if (!SLUG_RE.test(slug) || slug.length > 64) return null;
  try {
    return await (await getRegistry()).getSkill(slug);
  } catch (error) {
    if (isApiError(error) && error.code === 'NOT_FOUND') return null;
    throw error;
  }
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const detail = await load(slug);
  if (!detail) return { title: 'Skill not found' };
  return {
    title: detail.info.name,
    description: detail.info.summary.slice(0, 200),
  };
}

export default async function SkillPage({ params }: { params: Params }) {
  const { slug } = await params;
  const detail = await load(slug);
  if (!detail) notFound();

  const { info, shown } = detail;
  const findings = shown?.scan?.findings ?? [];
  // Prefer the stored totals: `findings` may be cut at the storage limit.
  let counts = shown?.scan?.counts;
  if (!counts) {
    counts = { INFO: 0, WARN: 0, BLOCK: 0 };
    for (const f of findings) counts[f.decision] += 1;
  }
  const findingsTotal = counts.INFO + counts.WARN + counts.BLOCK;
  const findingsTruncated = Boolean(shown?.scan?.findingsTruncated);
  const hasManifest = detail.files.some((file) => file.path === 'agenthub.yaml');

  let banner: ReactNode = null;
  if (!shown) {
    banner = (
      <Callout tone="warning" title="No version available" role="status">
        This skill has no published version to show or install.
      </Callout>
    );
  } else if (shown.status !== 'active') {
    banner = (
      <StatusBanner status={shown.status} version={shown.version} reason={detail.statusReason} />
    );
  }

  return (
    <>
      <SkillMasthead info={info} shown={shown} license={detail.license} banner={banner} />

      <Container className="pt-10 pb-6 lg:pt-14">
        {/*
         * Under 1024px the rail is `display: contents`: its panels join this one-column grid
         * and `order` puts the receipt and compatibility above the README.
         */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22.5rem] lg:items-start lg:gap-10">
          <ReadmePanel
            source={detail.readme}
            truncated={detail.readmeTruncated}
            className="order-3 lg:order-none lg:col-start-1 lg:row-start-1"
          />

          <StickyRail className="lg:col-start-2 lg:row-start-1">
            {shown ? (
              <TrustReceipt
                className="order-1"
                subject={`${info.slug}@${shown.version}`}
                digest={shown.digest}
                archiveDigest={shown.archiveDigest}
                scannerVersion={shown.scan?.scannerVersion}
                scannedAt={shown.scan?.scannedAt}
                outcome={shown.scan?.outcome}
                status={shown.status}
                counts={counts}
                footer={
                  <div className="grid gap-5">
                    <PermissionsList permissions={shown.permissions} hasManifest={hasManifest} />
                    <a
                      href="#findings"
                      className="inline-flex min-h-11 items-center justify-between gap-3 rounded-control border border-border bg-surface-2 px-3.5 text-small text-text no-underline transition-colors duration-150 hover:border-border-strong"
                    >
                      <span>
                        {findingsTotal === 0
                          ? 'Scan details'
                          : `Read all ${findingsTotal} ${findingsTotal === 1 ? 'finding' : 'findings'}`}
                      </span>
                      <ArrowDownIcon size={15} className="text-muted" />
                    </a>
                  </div>
                }
              >
                {shown.sizeBytes !== undefined ? (
                  <ReceiptRow label="Size">{formatBytes(shown.sizeBytes)}</ReceiptRow>
                ) : null}
                {shown.createdAt ? (
                  <ReceiptRow label="Published">{formatDate(shown.createdAt)}</ReceiptRow>
                ) : null}
              </TrustReceipt>
            ) : null}
            <CompatibilityPanel
              className="order-2"
              agents={shown?.agents ?? []}
              note={detail.compatibility}
            />
            <RequirementsPanel className="order-4" requirements={shown?.requirements} />
          </StickyRail>
        </div>
      </Container>

      <Container className="pb-16 lg:pb-24">
        {shown ? (
          <Reveal>
            <LedgerSection
              id="findings"
              eyebrow="Scan"
              title="Findings"
              lede={
                shown.scan
                  ? `Every file of ${shown.version} was checked by scanner ${shown.scan.scannerVersion}${shown.scan.scannedAt ? ` on ${formatDate(shown.scan.scannedAt)}` : ''}.`
                  : 'No scan has been recorded for this version.'
              }
              aside={
                findingsTotal > 0 ? (
                  <p className="flex flex-wrap gap-1.5">
                    <DecisionBadge decision="BLOCK" count={counts.BLOCK} />
                    <DecisionBadge decision="WARN" count={counts.WARN} />
                    <DecisionBadge decision="INFO" count={counts.INFO} />
                  </p>
                ) : null
              }
            >
              {findingsTruncated ? (
                <Callout tone="note" title="Not every finding is listed" className="mb-6">
                  {findings.length === 0
                    ? `The scan reported ${findingsTotal} ${findingsTotal === 1 ? 'finding' : 'findings'}, but they are not stored for display.`
                    : `Showing ${findings.length} of ${findingsTotal} findings, most severe first.`}{' '}
                  Run <code>agenthub info {info.slug}</code> or scan the package locally to see all
                  of them.
                </Callout>
              ) : null}
              {findings.length > 0 || !findingsTruncated ? (
                <FindingsLedger findings={findings} scanned={Boolean(shown.scan)} />
              ) : null}
            </LedgerSection>
          </Reveal>
        ) : null}

        <Reveal>
          <LedgerSection
            id="versions"
            eyebrow="History"
            title="Versions"
            lede="Published versions never change. A fix ships as a new version; a bad one is revoked."
          >
            <VersionsTable versions={info.versions} current={shown?.version} />
          </LedgerSection>
        </Reveal>

        {shown?.releaseNotes ? (
          <Reveal>
            <LedgerSection
              id="release-notes"
              eyebrow={`v${shown.version}`}
              title="Release notes"
              lede="Written by the publisher."
            >
              <p className="m-0 max-w-reading whitespace-pre-wrap text-body text-muted [overflow-wrap:anywhere]">
                {shown.releaseNotes}
              </p>
            </LedgerSection>
          </Reveal>
        ) : null}

        {shown ? (
          <Reveal>
            <LedgerSection
              id="files"
              eyebrow="Contents"
              title="Files"
              lede="What the package installs. Every file is covered by the content digest."
            >
              <FilesList files={detail.files} />
            </LedgerSection>
          </Reveal>
        ) : null}
      </Container>
    </>
  );
}
