'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { CommandPalette } from './CommandPalette';
import { Container } from './Container';
import { MenuIcon, SearchIcon, XIcon } from './icons';
import { Kbd } from './Kbd';
import { Modal } from './Modal';
import { ThemeToggle } from './ThemeToggle';
import type { Theme } from './theme';
import { Wordmark } from './Wordmark';

export interface SiteHeaderProps {
  /** Theme from the cookie, forwarded to the ThemeToggle. */
  initialTheme?: Theme;
}

const NAV = [
  { href: '/', label: 'Skills' },
  { href: '/guidelines', label: 'Guidelines' },
  { href: '/publish', label: 'Publish' },
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/admin', label: 'Admin' },
] as const;

function isCurrent(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/' || pathname.startsWith('/skills');
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Sticky, translucent header: wordmark, primary navigation, the search trigger that opens
 * the command palette, the theme toggle and (under 768px) a menu button that opens a sheet.
 * A hairline appears under it once the page is scrolled.
 */
export function SiteHeader({ initialTheme }: SiteHeaderProps) {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modifier, setModifier] = useState('Ctrl');

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setModifier('⌘');
  }, []);

  // The sheet closes when a link inside it changes the route.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not an input
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  return (
    <>
      <header
        className={cn(
          'sticky top-0 z-40 h-(--header-h) border-b bg-bg/95 backdrop-blur-md transition-[border-color] duration-200 supports-[backdrop-filter]:bg-bg/85',
          scrolled ? 'border-border' : 'border-transparent',
        )}
      >
        <Container className="flex h-full items-center gap-2">
          <Wordmark />

          <nav aria-label="Main" className="ml-5 hidden md:block">
            <ul className="flex items-center gap-0.5">
              {NAV.map((item) => {
                const current = isCurrent(item.href, pathname);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={current ? 'page' : undefined}
                      className={cn(
                        'inline-flex h-8 items-center rounded-chip px-2.5 text-small no-underline transition-colors duration-150 pointer-coarse:h-11',
                        current ? 'bg-surface-2 text-text' : 'text-muted hover:text-text',
                      )}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-haspopup="dialog"
              aria-keyshortcuts="Control+K Meta+K /"
              className="tap-target inline-flex h-9 items-center gap-2 rounded-control border border-transparent px-2.5 text-muted text-small transition-colors duration-150 hover:bg-surface-2 hover:text-text lg:w-60 lg:border-border-strong lg:bg-surface-1 lg:pr-1.5"
            >
              <SearchIcon size={16} />
              <span className="sr-only flex-1 text-left lg:not-sr-only">Search skills</span>
              <span aria-hidden="true" className="hidden items-center gap-1 lg:inline-flex">
                <Kbd>{modifier}</Kbd>
                <Kbd>K</Kbd>
              </span>
            </button>
            <ThemeToggle initialTheme={initialTheme} />
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={menuOpen}
              className="tap-target inline-flex size-9 shrink-0 items-center justify-center rounded-control text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text md:hidden"
            >
              <MenuIcon size={18} />
              <span className="sr-only">Open menu</span>
            </button>
          </div>
        </Container>
      </header>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />

      <Modal
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        label="Menu"
        placement="right"
        className="flex h-full w-[min(20rem,86vw)] flex-col border-border-strong border-l bg-surface-1 shadow-pop"
      >
        <div className="flex h-(--header-h) shrink-0 items-center justify-between border-border border-b pr-2 pl-4">
          <Wordmark link={false} />
          <button
            type="button"
            onClick={() => setMenuOpen(false)}
            className="tap-target inline-flex size-9 items-center justify-center rounded-control text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
          >
            <XIcon size={18} />
            <span className="sr-only">Close menu</span>
          </button>
        </div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto p-2">
          <ul className="grid gap-0.5">
            {NAV.map((item) => {
              const current = isCurrent(item.href, pathname);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={current ? 'page' : undefined}
                    onClick={() => setMenuOpen(false)}
                    className={cn(
                      'flex min-h-11 items-center rounded-control px-3 text-body no-underline transition-colors duration-150',
                      current ? 'bg-surface-2 text-text' : 'text-muted hover:text-text',
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="border-border border-t p-3">
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              setPaletteOpen(true);
            }}
            className="flex min-h-11 w-full items-center gap-2 rounded-control border border-border-strong bg-surface-2 px-3 text-muted text-small transition-colors duration-150 hover:text-text"
          >
            <SearchIcon size={16} />
            Search skills
          </button>
        </div>
      </Modal>
    </>
  );
}
