import { NextResponse } from 'next/server';
import { createDraftRelease, listReleases } from '@/lib/github.ts';
import { CHUNK_SIZE, chunkCount, jobTag, newJobId } from '@/lib/jobs.ts';
import { gh } from '@/lib/env.ts';

// Новая задача: черновик релиза job-<id>; браузер дальше шлёт куски в /api/jobs/<id>/parts/<n>.
export async function POST(request: Request) {
  const { name, size, type } = (await request.json()) as { name?: string; size?: number; type?: string };
  if (!name || !Number.isFinite(size) || !size || size <= 0) {
    return NextResponse.json({ error: 'name and size are required' }, { status: 400 });
  }
  const jobId = newJobId();
  const rel = await createDraftRelease(gh(), jobTag(jobId), name, `Исходник: ${name}, ${size} байт, ${type || 'тип неизвестен'}`);
  return NextResponse.json({ jobId, releaseId: rel.id, chunkSize: CHUNK_SIZE, parts: chunkCount(size) });
}

// Список задач для «Мои видео».
export async function GET() {
  const rels = (await listReleases(gh())).filter((r) => r.tag_name.startsWith('job-'));
  return NextResponse.json(rels.map((r) => ({
    jobId: r.tag_name.slice(4),
    title: r.name,
    createdAt: r.created_at,
    parts: r.assets.filter((a) => a.name.startsWith('source.part-')).length,
    bytes: r.assets.filter((a) => a.name.startsWith('source.part-')).reduce((s, a) => s + a.size, 0),
    uploaded: r.assets.some((a) => a.name === 'manifest.json'),
    outputs: r.assets.filter((a) => a.name.startsWith('final')).map((a) => a.name),
  })));
}
