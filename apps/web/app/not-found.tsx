import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">Not found</h1>
      <p className="mt-3 text-muted">
        There is no page or skill at this address. Skill names are lowercase and use hyphens, for
        example <code>web-testing</code>.
      </p>
      <p className="mt-6">
        <Link href="/">Search the registry</Link>
      </p>
    </div>
  );
}
