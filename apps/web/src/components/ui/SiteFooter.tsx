import Link from 'next/link';
import { Container } from './Container';
import { Wordmark } from './Wordmark';

export interface SiteFooterProps {
  /** Value of AGENTHUB_SECURITY_CONTACT, read by the server layout. Hidden when unset. */
  securityContact?: string | null;
}

const GROUPS = [
  {
    title: 'Registry',
    links: [
      { href: '/', label: 'Skills' },
      { href: '/publish', label: 'Publish' },
      { href: '/dashboard', label: 'Dashboard' },
    ],
  },
  {
    title: 'Trust',
    links: [
      { href: '/guidelines', label: 'Guidelines' },
      { href: '/guidelines#security-model', label: 'Security model' },
      { href: '/guidelines#reporting', label: 'Report a skill' },
    ],
  },
] as const;

const LINK =
  'tap-target inline-flex h-8 items-center text-muted text-small no-underline transition-colors duration-150 hover:text-text';

export function SiteFooter({ securityContact }: SiteFooterProps) {
  return (
    <footer className="mt-auto border-border border-t bg-surface-1">
      <Container className="grid gap-10 py-12 md:grid-cols-[minmax(0,1fr)_auto] md:gap-16">
        <div className="max-w-sm">
          <Wordmark link={false} />
          <p className="mt-4 text-muted text-small">
            The package manager and trust layer for agent skills.
          </p>
          <p className="mt-2 text-[0.8125rem] text-subtle leading-5">
            Every version is immutable, content-addressed and scanned before anyone can install it.
          </p>
        </div>
        <nav aria-label="Footer" className="grid grid-cols-2 gap-x-12 gap-y-8 sm:gap-x-16">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <p className="eyebrow">{group.title}</p>
              <ul className="mt-3 grid gap-1">
                {group.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className={LINK}>
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </Container>
      <div className="border-border border-t">
        <Container className="flex flex-col gap-2 py-5 font-mono text-[0.75rem] text-subtle leading-5 sm:flex-row sm:items-center sm:justify-between">
          <p>Open Agent Skills format · SKILL.md</p>
          {securityContact ? (
            <p>
              Security contact: <span className="break-all text-text">{securityContact}</span>
            </p>
          ) : null}
        </Container>
      </div>
    </footer>
  );
}
