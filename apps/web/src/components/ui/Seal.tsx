import { cn } from '../../lib/cn';

/** A twelve-lobe scalloped stamp on a 24px grid. */
const SEAL_PATH =
  'M12 2.8A2.6 2.6 0 0 1 16.6 4.03A2.6 2.6 0 0 1 19.97 7.4A2.6 2.6 0 0 1 21.2 12A2.6 2.6 0 0 1 19.97 16.6A2.6 2.6 0 0 1 16.6 19.97A2.6 2.6 0 0 1 12 21.2A2.6 2.6 0 0 1 7.4 19.97A2.6 2.6 0 0 1 4.03 16.6A2.6 2.6 0 0 1 2.8 12A2.6 2.6 0 0 1 4.03 7.4A2.6 2.6 0 0 1 7.4 4.03A2.6 2.6 0 0 1 12 2.8Z';

const CHECK_PATH = 'm8.3 12.2 2.5 2.5 4.9-5.1';

export interface SealProps {
  /** Width and height in pixels. */
  size?: number;
  /** Accessible name. Without it the seal is decorative. */
  label?: string;
  className?: string;
}

/**
 * The agenthub seal: the brand glyph and the "verified" mark. Filled with the signal color,
 * outlined with signal-ink so it keeps its edge on the light theme.
 */
export function Seal({ size = 18, label, className }: SealProps) {
  const shared = {
    xmlns: 'http://www.w3.org/2000/svg',
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    focusable: false,
    className: cn('shrink-0', className),
  } as const;
  const shapes = (
    <>
      <path
        d={SEAL_PATH}
        fill="var(--signal)"
        stroke="var(--signal-ink)"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path
        d={CHECK_PATH}
        fill="none"
        stroke="var(--on-signal)"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );
  if (label) {
    return (
      <svg {...shared} role="img" aria-label={label}>
        <title>{label}</title>
        {shapes}
      </svg>
    );
  }
  return (
    <svg {...shared} aria-hidden="true">
      {shapes}
    </svg>
  );
}
