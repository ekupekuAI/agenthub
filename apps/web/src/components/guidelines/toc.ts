/**
 * The outline of the Guidelines page. The page headings, the sticky table of contents and
 * the scrollspy all read this one list, so an id or a label can never drift between them.
 */

export interface TocEntry {
  readonly id: string;
  readonly label: string;
}

export interface TocSection extends TocEntry {
  readonly children: readonly TocEntry[];
}

export const TOC = [
  {
    id: 'quick-start',
    label: 'Quick start',
    children: [
      { id: 'check-your-setup', label: 'Check your setup' },
      { id: 'choose-a-registry', label: 'Choose a registry' },
      { id: 'find-and-inspect', label: 'Find and inspect a skill' },
      { id: 'install-list-verify', label: 'Install, list and verify' },
      { id: 'update-rollback-remove', label: 'Update, roll back and remove' },
      { id: 'scopes', label: 'Project scope vs user scope' },
      { id: 'two-folders', label: 'Two folders for four agents' },
      { id: 'command-reference', label: 'Command reference' },
      { id: 'exit-codes', label: 'Exit codes' },
    ],
  },
  {
    id: 'installing-safely',
    label: 'Installing safely',
    children: [
      { id: 'read-the-plan', label: 'Read the install plan' },
      { id: 'decisions', label: 'What INFO, WARN and BLOCK mean' },
      { id: 'check-digests', label: 'Check digests' },
      { id: 'review-updates', label: 'Review updates before applying them' },
      { id: 'how-rollback-works', label: 'How rollback works' },
    ],
  },
  {
    id: 'writing-a-safe-skill',
    label: 'Writing a safe skill',
    children: [
      { id: 'skill-md-rules', label: 'SKILL.md rules' },
      { id: 'declare-permissions', label: 'Declare permissions honestly in agenthub.yaml' },
      { id: 'reviewable-practices', label: 'Practices that keep a skill reviewable' },
      { id: 'test-before-publishing', label: 'Test before you publish' },
    ],
  },
  {
    id: 'publishing-rules',
    label: 'Publishing rules',
    children: [],
  },
  {
    id: 'security-model',
    label: 'Security model',
    children: [
      { id: 'integrity', label: 'Integrity' },
      { id: 'scanner-rules', label: 'Scanner rules' },
      { id: 'scanner-limits', label: 'What the scanner cannot promise' },
    ],
  },
  {
    id: 'reporting',
    label: 'Reporting a malicious skill or vulnerability',
    children: [],
  },
  {
    id: 'troubleshooting',
    label: 'Troubleshooting',
    children: [
      { id: 'agent-does-not-show-skill', label: 'The agent does not show the skill' },
      { id: 'verify-reports-drift', label: 'verify reports drift' },
      { id: 'windows-file-locks', label: 'Windows file locks' },
    ],
  },
] as const satisfies readonly TocSection[];

export type SectionId = (typeof TOC)[number]['id'];
export type SubsectionId = (typeof TOC)[number]['children'][number]['id'];

const SECTIONS: readonly TocSection[] = TOC;

/** Every heading id in document order: each section followed by its subsections. */
export const HEADING_IDS: readonly string[] = SECTIONS.flatMap((section) => [
  section.id,
  ...section.children.map((child) => child.id),
]);

const SECTION_BY_HEADING = new Map<string, TocSection>();
const LABEL_BY_HEADING = new Map<string, string>();
for (const section of SECTIONS) {
  SECTION_BY_HEADING.set(section.id, section);
  LABEL_BY_HEADING.set(section.id, section.label);
  for (const child of section.children) {
    SECTION_BY_HEADING.set(child.id, section);
    LABEL_BY_HEADING.set(child.id, child.label);
  }
}

/** The section a heading belongs to (a section id maps to itself). */
export function sectionOf(headingId: string | null): TocSection | null {
  return headingId === null ? null : (SECTION_BY_HEADING.get(headingId) ?? null);
}

/** 1-based position of a section, as printed in its heading ("5. Security model"). */
export function sectionNumber(id: SectionId): number {
  return SECTIONS.findIndex((section) => section.id === id) + 1;
}

export function headingLabel(id: SectionId | SubsectionId): string {
  return LABEL_BY_HEADING.get(id) ?? id;
}
