export interface SkipLinkProps {
  /** Id of the main landmark. */
  targetId?: string;
}

/** First focusable element on every page: jumps past the header to the main content. */
export function SkipLink({ targetId = 'main' }: SkipLinkProps) {
  return (
    <a
      href={`#${targetId}`}
      className="sr-only rounded-control bg-signal px-4 py-2.5 font-medium text-on-signal text-small no-underline focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:inline-flex focus:min-h-11 focus:items-center"
    >
      Skip to content
    </a>
  );
}
