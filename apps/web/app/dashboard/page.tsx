import type { Metadata } from 'next';
import { DashboardView } from './DashboardView';

export const metadata: Metadata = {
  title: 'Publisher dashboard',
  description: 'See your published skills, their versions, statuses and scan outcomes.',
};

export default function DashboardPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">Publisher dashboard</h1>
      <p className="mt-3 max-w-2xl text-muted">
        Enter your publisher token to see your skills, every version you have published, and what
        the scanner found. The token is checked on the server for this request only; nothing is
        saved in your browser.
      </p>
      <div className="mt-8">
        <DashboardView />
      </div>
    </div>
  );
}
