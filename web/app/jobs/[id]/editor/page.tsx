import { notFound } from 'next/navigation';
import { isJobId } from '@/lib/jobs.ts';
import Editor from './editor';

export const metadata = { title: 'Редактор · video.edit' };

export default async function EditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isJobId(id)) notFound();
  return <Editor id={id} />;
}
