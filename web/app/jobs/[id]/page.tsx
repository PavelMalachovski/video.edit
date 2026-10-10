import { notFound } from 'next/navigation';
import { isJobId } from '@/lib/jobs.ts';
import Job from './job';

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isJobId(id)) notFound();
  return (
    <main>
      <Job id={id} />
    </main>
  );
}
