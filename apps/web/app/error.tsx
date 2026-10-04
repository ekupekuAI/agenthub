'use client';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">Something went wrong</h1>
      <p className="mt-3 text-muted">
        The registry could not complete this request. Nothing was changed. Try again in a moment.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 rounded-md bg-accent px-5 py-2 font-semibold text-accent-ink hover:bg-accent-strong"
      >
        Try again
      </button>
    </div>
  );
}
