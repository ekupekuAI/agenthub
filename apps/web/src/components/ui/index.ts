/**
 * The ledger UI kit (docs/specs/2026-10-04-web-design.md §4).
 *
 * Files that start with 'use client' are client components; everything else also renders in
 * server components. Import from this barrel: `import { Button, Container } from '…/ui'`.
 */

export { AgentStrip, type AgentStripProps, type AgentStripSize } from './AgentStrip';
export { AGENT_IDS, AGENT_META, type AgentId, type AgentMeta } from './agents';
export { Badge, type BadgeProps, type BadgeTone } from './Badge';
export {
  Button,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
  buttonClasses,
} from './Button';
export { Callout, type CalloutProps, type CalloutTone } from './Callout';
export { Checkbox, type CheckboxProps } from './Checkbox';
export { CommandPalette, type CommandPaletteProps } from './CommandPalette';
export {
  Container,
  type ContainerProps,
  type ContainerWidth,
  Section,
  type SectionProps,
} from './Container';
export { CopyCommand, type CopyCommandProps } from './CopyCommand';
export { type Decision, DecisionBadge, type DecisionBadgeProps } from './DecisionBadge';
export { Dialog, type DialogProps } from './Dialog';
export { DigestChip, type DigestChipProps } from './DigestChip';
export { Dropzone, type DropzoneProps } from './Dropzone';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { Eyebrow, type EyebrowProps } from './Eyebrow';
export {
  CONTROL_CLASSES,
  type ComposedFieldProps,
  describedBy,
  Field,
  type FieldProps,
  fieldIds,
} from './Field';
export {
  type FindingLike,
  FindingList,
  type FindingListProps,
  FindingRow,
  type FindingRowProps,
} from './FindingRow';
export { formatBytes, formatDate, shortenDigest } from './format';
export {
  useCopy,
  useFocusTrap,
  useIsClient,
  usePrefersReducedMotion,
  useScrollLock,
} from './hooks';
export { Input, type InputProps, TextField, type TextFieldProps } from './Input';
export * from './icons';
export { Kbd, type KbdProps } from './Kbd';
export { Modal, type ModalPlacement, type ModalProps } from './Modal';
export { MotionProvider } from './MotionProvider';
export { OutcomeBadge, type OutcomeBadgeProps, type ScanOutcomeValue } from './OutcomeBadge';
export { PageHeader, type PageHeaderProps } from './PageHeader';
export {
  Reveal,
  type RevealProps,
  type RevealTag,
  Stagger,
  StaggerItem,
  type StaggerItemProps,
  type StaggerProps,
} from './Reveal';
export { Seal, type SealProps } from './Seal';
export { SectionHeading, type SectionHeadingProps } from './SectionHeading';
export { Select, SelectField, type SelectFieldProps, type SelectProps } from './Select';
export { ShimmerButton, type ShimmerButtonProps } from './ShimmerButton';
export { SiteFooter, type SiteFooterProps } from './SiteFooter';
export { SiteHeader, type SiteHeaderProps } from './SiteHeader';
export { Skeleton, type SkeletonProps } from './Skeleton';
export { SkipLink, type SkipLinkProps } from './SkipLink';
export { SpotlightCard, type SpotlightCardProps } from './SpotlightCard';
export { StatusBadge, type StatusBadgeProps, type VersionStatusValue } from './StatusBadge';
export {
  Table,
  type TableProps,
  TBody,
  TD,
  type TDProps,
  TH,
  THead,
  type THProps,
  TR,
} from './Table';
export {
  type TabDescriptor,
  type TabItem,
  TabList,
  type TabListProps,
  Tabs,
  type TabsProps,
  type TabsVariant,
  tabId,
  tabPanelId,
} from './Tabs';
export {
  AnimatedSpan,
  type AnimatedSpanProps,
  Terminal,
  type TerminalLine,
  type TerminalLineKind,
  type TerminalProps,
  type TerminalScenario,
  TypingAnimation,
  type TypingAnimationProps,
} from './Terminal';
export { Textarea, TextareaField, type TextareaFieldProps, type TextareaProps } from './Textarea';
export { ThemeToggle, type ThemeToggleProps } from './ThemeToggle';
export {
  ReceiptRow,
  type ReceiptRowProps,
  TrustReceipt,
  type TrustReceiptProps,
  type Verdict,
  VerdictStamp,
  type VerdictStampProps,
  verdictOf,
} from './TrustReceipt';
export {
  parseTheme,
  THEME_COLORS,
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  type Theme,
} from './theme';
export { VerifiedMark, type VerifiedMarkProps } from './VerifiedMark';
export { Wordmark, type WordmarkProps } from './Wordmark';
