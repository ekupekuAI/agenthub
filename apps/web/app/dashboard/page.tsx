import type { Metadata } from 'next';
import { Container, PageHeader } from '../../src/components/ui';
import { DashboardView } from './DashboardView';

export const metadata: Metadata = {
  title: 'Publisher dashboard',
  description: 'See your published skills, their versions, statuses and scan outcomes.',
};

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        eyebrow="Dashboard"
        title={
          <>
            Everything you have <em>published</em>
          </>
        }
        lede="Enter your publisher token to see your skills, every version you have published and what the scanner found. The token is checked on the server for this request only."
      />
      <Container className="py-10 lg:py-16">
        <DashboardView />
      </Container>
    </>
  );
}
