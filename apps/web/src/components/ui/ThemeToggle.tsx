'use client';

import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { MoonIcon, SunIcon } from './icons';
import { THEME_COLORS, THEME_COOKIE, THEME_COOKIE_MAX_AGE, type Theme } from './theme';

export interface ThemeToggleProps {
  /** The theme stored in the cookie, read by the server layout. Undefined: follow the system. */
  initialTheme?: Theme;
  className?: string;
}

function currentTheme(): Theme {
  const attribute = document.documentElement.dataset.theme;
  if (attribute === 'dark' || attribute === 'light') return attribute;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * Switches `data-theme` on <html> and remembers the choice in the `agenthub-theme` cookie
 * (SameSite=Lax, one year, holds only "dark" or "light"). The server layout reads the cookie
 * and renders the attribute, so there is no flash and no inline script. The two icons are
 * swapped in CSS, which keeps the server and client markup identical.
 */
export function ThemeToggle({ initialTheme, className }: ThemeToggleProps) {
  const [theme, setTheme] = useState<Theme | undefined>(initialTheme);

  useEffect(() => {
    setTheme((known) => known ?? currentTheme());
  }, []);

  function toggle() {
    const next: Theme = (theme ?? currentTheme()) === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is not available in every supported browser; the value is a fixed, non-sensitive enum
    document.cookie = `${THEME_COOKIE}=${next}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      meta.removeAttribute('media');
      meta.setAttribute('content', THEME_COLORS[next]);
    }
    setTheme(next);
  }

  const label =
    theme === 'light'
      ? 'Switch to dark theme'
      : theme === 'dark'
        ? 'Switch to light theme'
        : 'Switch color theme';

  return (
    <button
      type="button"
      onClick={toggle}
      title={label}
      className={cn(
        'tap-target inline-flex size-9 shrink-0 items-center justify-center rounded-control text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text',
        className,
      )}
    >
      <SunIcon size={18} className="theme-icon-dark" />
      <MoonIcon size={18} className="theme-icon-light" />
      <span className="sr-only">{label}</span>
    </button>
  );
}
