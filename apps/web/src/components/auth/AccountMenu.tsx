'use client';

import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { ChevronDownIcon, LayoutDashboardIcon, UploadIcon } from '../ui/icons';
import { GitHubMark } from './GitHubSignIn';

export interface HeaderAccount {
  /** Publisher display name. */
  name: string;
  /** GitHub login at the last sign-in. */
  login: string;
}

/** A monogram instead of the GitHub avatar: the CSP allows no external images. */
export function Monogram({ text, className }: { text: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-signal-line bg-signal-tint font-mono text-[0.75rem] text-signal-ink uppercase',
        className,
      )}
    >
      {text.slice(0, 2)}
    </span>
  );
}

/** Sign-out is a same-origin form post (Origin-checked on the server). */
export function SignOutForm({ className }: { className?: string }) {
  return (
    <form method="post" action="/api/auth/signout" className={className}>
      <button
        type="submit"
        className="flex min-h-10 w-full items-center rounded-control px-3 text-left text-muted text-small transition-colors duration-150 hover:bg-surface-2 hover:text-text"
      >
        Sign out
      </button>
    </form>
  );
}

/** Signed-in header control: login plus a small menu (Dashboard, Publish, Sign out). */
export function AccountMenu({ account }: { account: HeaderAccount }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
        className="tap-target inline-flex h-9 items-center gap-2 rounded-control border border-transparent pr-1.5 pl-1 text-muted text-small transition-colors duration-150 hover:bg-surface-2 hover:text-text"
      >
        <Monogram text={account.login} />
        <span className="hidden max-w-[10rem] truncate lg:inline">{account.login}</span>
        <ChevronDownIcon size={14} />
        <span className="sr-only">Account menu for {account.login}</span>
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            id={menuId}
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
            className="absolute right-0 z-50 mt-2 w-64 origin-top-right rounded-card border border-border-strong bg-surface-1 p-1.5 shadow-pop"
          >
            <div className="flex items-center gap-2.5 border-border border-b px-2.5 pt-1.5 pb-3">
              <Monogram text={account.login} />
              <div className="min-w-0">
                <p className="m-0 truncate text-small text-text">{account.name}</p>
                <p className="m-0 flex items-center gap-1 truncate font-mono text-[0.75rem] text-muted">
                  <GitHubMark size={12} />
                  {account.login}
                </p>
              </div>
            </div>
            <ul className="m-0 grid list-none gap-0.5 p-0 pt-1.5">
              <li>
                <Link
                  href="/dashboard"
                  onClick={() => setOpen(false)}
                  className="flex min-h-10 items-center gap-2 rounded-control px-3 text-muted text-small no-underline transition-colors duration-150 hover:bg-surface-2 hover:text-text"
                >
                  <LayoutDashboardIcon size={15} />
                  Dashboard
                </Link>
              </li>
              <li>
                <Link
                  href="/publish"
                  onClick={() => setOpen(false)}
                  className="flex min-h-10 items-center gap-2 rounded-control px-3 text-muted text-small no-underline transition-colors duration-150 hover:bg-surface-2 hover:text-text"
                >
                  <UploadIcon size={15} />
                  Publish
                </Link>
              </li>
              <li className="mt-1 border-border border-t pt-1">
                <SignOutForm />
              </li>
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
