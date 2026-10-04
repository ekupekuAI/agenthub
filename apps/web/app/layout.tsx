import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { securityContact } from '../src/config';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'agenthub — the package manager and trust layer for agent skills',
    template: '%s · agenthub',
  },
  description:
    'Search, inspect and install agent skills for Claude Code, Codex, Cursor and VS Code with content digests, security scans and revocation.',
  applicationName: 'agenthub',
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0f14' },
  ],
};

const NAV = [
  { href: '/', label: 'Search' },
  { href: '/guidelines', label: 'Guidelines' },
  { href: '/publish', label: 'Publish' },
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/admin', label: 'Admin' },
];

function Logo() {
  return (
    <svg aria-hidden="true" width="26" height="26" viewBox="0 0 32 32" className="shrink-0">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--accent)" />
      <path
        d="M9 21.5 16 8l7 13.5M11.6 17h8.8"
        stroke="var(--accent-ink)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading request headers opts every page into dynamic rendering, which the nonce CSP needs.
  await headers();
  const contact = securityContact();

  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col antialiased">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="sticky top-0 z-40 border-b border-line bg-canvas/95 backdrop-blur supports-[backdrop-filter]:bg-canvas/80">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
            <Link
              href="/"
              className="flex items-center gap-2 font-semibold tracking-tight text-ink no-underline hover:text-ink"
            >
              <Logo />
              <span className="text-lg">agenthub</span>
            </Link>
            <nav aria-label="Main" className="w-full sm:w-auto sm:ml-auto">
              <ul className="flex flex-wrap gap-x-1 gap-y-1 text-sm">
                {NAV.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="block rounded-md px-2.5 py-1.5 font-medium text-muted no-underline transition-colors hover:bg-raised hover:text-ink"
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </header>

        <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
          {children}
        </main>

        <footer className="mt-16 border-t border-line bg-surface">
          <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-muted sm:flex-row sm:items-start sm:justify-between sm:px-6">
            <div>
              <p className="font-semibold text-ink">agenthub</p>
              <p>The package manager and trust layer for agent skills.</p>
            </div>
            <div className="flex flex-col gap-1 sm:items-end">
              <nav aria-label="Footer">
                <ul className="flex flex-wrap gap-4">
                  <li>
                    <Link href="/guidelines">Guidelines</Link>
                  </li>
                  <li>
                    <Link href="/guidelines#security-model">Security model</Link>
                  </li>
                  <li>
                    <Link href="/guidelines#reporting">Report a skill</Link>
                  </li>
                </ul>
              </nav>
              {contact ? (
                <p>
                  Security contact: <span className="font-mono text-ink">{contact}</span>
                </p>
              ) : null}
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
