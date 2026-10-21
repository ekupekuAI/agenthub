import { cn } from '../../lib/cn';

/**
 * The agenthub logo ("A-check") on a 24px grid: a capital A whose crossbar is a check mark,
 * the tick running through the right leg. Shared with the favicon (app/icon.svg), the plush
 * tile and the page-change sheets, so keep these paths in one place.
 */
export const LOGO_TILE = { x: 1, y: 1, size: 22, radius: 6 } as const;
export const LOGO_LEGS_PATH = 'M6.6 18.2L12 5.2L17.4 18.2';
export const LOGO_CHECK_PATH = 'M8.9 13.9L11.1 15.9L16.2 10.6';
export const LOGO_LEGS_WIDTH = 2.7;
export const LOGO_CHECK_WIDTH = 1.9;

export interface LogoProps {
  /** Width and height in pixels. */
  size?: number;
  /** Accessible name. Without it the logo is decorative. */
  label?: string;
  className?: string;
}

/**
 * The logo as a lime tile with the mark in ink. The tile keeps a signal-ink outline so it holds
 * its edge on the light theme, as the seal does.
 */
export function Logo({ size = 20, label, className }: LogoProps) {
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
      <rect
        x={LOGO_TILE.x}
        y={LOGO_TILE.y}
        width={LOGO_TILE.size}
        height={LOGO_TILE.size}
        rx={LOGO_TILE.radius}
        fill="var(--signal)"
        stroke="var(--signal-ink)"
        strokeWidth="1"
      />
      <path
        d={LOGO_LEGS_PATH}
        fill="none"
        stroke="var(--on-signal)"
        strokeWidth={LOGO_LEGS_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={LOGO_CHECK_PATH}
        fill="none"
        stroke="var(--on-signal)"
        strokeWidth={LOGO_CHECK_WIDTH}
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
