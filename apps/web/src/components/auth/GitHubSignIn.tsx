import { cn } from '../../lib/cn';
import { type ButtonSize, buttonClasses } from '../ui';

/** The GitHub mark, inline (no external images under the CSP). */
export function GitHubMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable={false}
      className={cn('shrink-0', className)}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export const START_HREF = '/api/auth/github/start';

/**
 * "Sign in with GitHub". A plain link (not next/link): the start route answers with a redirect
 * to github.com, which must be a full navigation. Without GitHub configured it renders a
 * disabled button that says so.
 */
export function GitHubSignInButton({
  enabled,
  next,
  size = 'lg',
  fullWidth = true,
  className,
}: {
  enabled: boolean;
  next?: 'dashboard' | 'publish';
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
}) {
  if (!enabled) {
    return (
      <div className={cn('grid gap-2', className)}>
        <button
          type="button"
          disabled
          aria-describedby="github-signin-unavailable"
          className={buttonClasses({ variant: 'secondary', size, fullWidth })}
        >
          <GitHubMark size={size === 'sm' ? 15 : 18} />
          Sign in with GitHub
        </button>
        <p id="github-signin-unavailable" className="m-0 text-[0.8125rem] text-muted leading-5">
          GitHub sign-in is not configured on this registry. A publisher token still works.
        </p>
      </div>
    );
  }
  return (
    <a
      href={next === 'publish' ? `${START_HREF}?next=publish` : START_HREF}
      className={buttonClasses({ variant: 'primary', size, fullWidth, className })}
    >
      <GitHubMark size={size === 'sm' ? 15 : 18} />
      Sign in with GitHub
    </a>
  );
}
