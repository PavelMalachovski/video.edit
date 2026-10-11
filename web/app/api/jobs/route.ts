import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/http.ts';
import { createDraftRelease, listAllAssets, listReleases } from '@/lib/github.ts';
import { listHeads } from '@/lib/branch.ts';
import { deriveView, readJobFiles, type Screen } from '@/lib/jobview.ts';
import { CHUNK_SIZE, checkSource, chunkCount, isJobId, jobBranch, jobTag, newJobId } from '@/lib/jobs.ts';
import { gh } from '@/lib/env.ts';

export const maxDuration = 60;

// Новая задача: черновик релиза job-<id>; браузер дальше шлёт куски в /api/jobs/<id>/parts/<n>.
export async function POST(request: Request) {
  try {
    const { name, size, type } = (await request.json()) as { name?: string; size?: number; type?: string };
    if (!name || !Number.isFinite(size) || !size || size <= 0) {
      return NextResponse.json({ error: 'name and size are required' }, { status: 400 });
    }
    const tooBig = checkSource(size);
    if (tooBig) return NextResponse.json({ error: tooBig }, { status: 413 });
    const jobId = newJobId();
    const rel = await createDraftRelease(gh(), jobTag(jobId), name, `Исходник: ${name}, ${size} байт, ${type || 'тип неизвестен'}`);
    return NextResponse.json({ jobId, releaseId: rel.id, chunkSize: CHUNK_SIZE, parts: chunkCount(size) });
  } catch (e) {
    return errorResponse(e);
  }
}

const ORDER: Record<Screen, number> = { working: 0, questions: 1, not_started: 2, uploading: 2, error: 3, result: 4, script: 4 };

/** `fn` над `items` не больше `limit` за раз, порядок результатов — как у `items`. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Список задач для «Мои видео»: в работе и ждущие ответа — вверху, внутри групп — новые выше.
export async function GET() {
  try {
    const g = gh();
    const releases = (await listReleases(g)).filter((r) => r.tag_name.startsWith('job-') && isJobId(r.tag_name.slice(4)));
    const heads = await listHeads(g, 'claude/job-');
    const rows = await mapLimit(releases, 6, async (r) => {
      const id = r.tag_name.slice(4);
      const head = heads.get(jobBranch(id));
      const files = head ? await readJobFiles(g, id, head, 'list') : null;
      const release = files?.job?.runs.length ? r : { ...r, assets: await listAllAssets(g, r.id) };
      const v = deriveView(release, files, Date.now());
      return { jobId: id, title: v.title, createdAt: v.createdAt, duration: v.duration, screen: v.screen, phase: v.status?.phase ?? null, stuck: v.stuck };
    });
    rows.sort((a, b) => ORDER[a.screen] - ORDER[b.screen] || b.createdAt.localeCompare(a.createdAt));
    return NextResponse.json(rows);
  } catch (e) {
    return errorResponse(e);
  }
}
