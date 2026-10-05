import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';
import { MotionProvider } from '../src/components/ui/MotionProvider';
import { SiteFooter } from '../src/components/ui/SiteFooter';
import { SiteHeader } from '../src/components/ui/SiteHeader';
import { SkipLink } from '../src/components/ui/SkipLink';
import { parseTheme, THEME_COLORS, THEME_COOKIE } from '../src/components/ui/theme';
import { githubOAuth, securityContact } from '../src/config';
import { currentPublisher } from '../src/lib/action-guard';
import { cn } from '../src/lib/cn';
import './globals.css';

/*
 * Fonts are self-hosted from app/fonts (see app/fonts/LICENSE.txt): nothing is fetched at
 * build time or at run time. globals.css composes these variables into --font-sans,
 * --font-mono and --font-display.
 */
const geist = localFont({
  src: './fonts/geist-latin-wght-normal.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-geist',
});

const geistMono = localFont({
  src: './fonts/geist-mono-latin-wght-normal.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-geist-mono',
  adjustFontFallback: false,
});

/** Box-drawing glyphs for terminal output; downloaded only when such a character is used. */
const geistMonoBox = localFont({
  src: './fonts/geist-mono-symbols2-wght-normal.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-geist-mono-box',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'U+23B8-23BD, U+2500-259F' }],
});

const instrumentSerif = localFont({
  src: [
    { path: './fonts/instrument-serif-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/instrument-serif-latin-400-italic.woff2', weight: '400', style: 'italic' },
  ],
  display: 'swap',
  variable: '--font-instrument-serif',
  adjustFontFallback: 'Times New Roman',
});

export const metadata: Metadata = {
  title: {
    default: 'agenthub · the package manager and trust layer for agent skills',
    template: '%s · agenthub',
  },
  description:
    'Search, inspect and install agent skills for Claude Code, Codex, Cursor and VS Code with content digests, security scans and revocation.',
  applicationName: 'agenthub',
  robots: { index: true, follow: true },
};

async function storedTheme() {
  return parseTheme((await cookies()).get(THEME_COOKIE)?.value);
}

export async function generateViewport(): Promise<Viewport> {
  const theme = await storedTheme();
  return {
    width: 'device-width',
    initialScale: 1,
    colorScheme: theme ?? 'dark light',
    themeColor: theme
      ? THEME_COLORS[theme]
      : [
          { media: '(prefers-color-scheme: light)', color: THEME_COLORS.light },
          { media: '(prefers-color-scheme: dark)', color: THEME_COLORS.dark },
        ],
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading request headers opts every page into dynamic rendering, which the nonce CSP needs.
  await headers();
  // The theme cookie is rendered into the markup, so the first paint is already correct.
  const theme = await storedTheme();
  const contact = securityContact();
  // Only reads the database when a session cookie is present.
  const me = await currentPublisher().catch(() => null);
  const account = me
    ? {
        name: me.publisher.displayName,
        login: me.publisher.githubLogin ?? me.publisher.displayName,
      }
    : null;

  return (
    <html
      lang="en"
      data-theme={theme}
      className={cn(
        geist.variable,
        geistMono.variable,
        geistMonoBox.variable,
        instrumentSerif.variable,
      )}
    >
      <body className="flex min-h-dvh flex-col">
        {/* Without JavaScript nothing animates in, so reveal targets are shown as final. */}
        <noscript>
          <style>
            {
              '[data-reveal]{opacity:1!important;transform:none!important}[data-pending]{visibility:visible!important}'
            }
          </style>
        </noscript>
        <MotionProvider>
          <SkipLink />
          <SiteHeader
            initialTheme={theme}
            account={account}
            githubSignIn={githubOAuth() !== null}
          />
          <main id="main" tabIndex={-1} className="flex-1">
            {children}
          </main>
          <SiteFooter securityContact={contact} />
        </MotionProvider>
      </body>
    </html>
  );
}
