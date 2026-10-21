import { Container, Skeleton } from '../src/components/ui';

/**
 * Shown the instant a link is followed, while the next page renders on the server, so a
 * click always gets visible feedback even on a slow connection.
 */
export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="py-12 lg:py-20">
      <span className="sr-only">Loading page</span>
      <div aria-hidden="true" className="fixed inset-x-0 top-0 z-[90] h-0.5 overflow-hidden">
        <div className="h-full w-2/5 animate-route-progress bg-signal motion-reduce:animate-none" />
      </div>
      <Container aria-hidden="true" className="grid gap-5">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-12 w-full max-w-xl" />
        <Skeleton className="h-4 w-full max-w-2xl" />
        <Skeleton className="h-4 w-full max-w-lg" />
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-36 rounded-card" />
          <Skeleton className="h-36 rounded-card" />
          <Skeleton className="h-36 rounded-card" />
        </div>
      </Container>
    </div>
  );
}
