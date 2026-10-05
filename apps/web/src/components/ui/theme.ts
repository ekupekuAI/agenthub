export type Theme = 'dark' | 'light';

/** Cookie that stores the visitor's explicit theme choice. Holds only `dark` or `light`. */
export const THEME_COOKIE = 'agenthub-theme';

/** One year, in seconds. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Browser chrome color per theme (matches --bg). */
export const THEME_COLORS: Record<Theme, string> = {
  dark: '#0b0c0e',
  light: '#fafaf7',
};

export function parseTheme(value: string | undefined | null): Theme | undefined {
  return value === 'dark' || value === 'light' ? value : undefined;
}
