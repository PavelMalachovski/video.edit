import { NextResponse } from 'next/server';
import { commitCache, errorResponse } from '@/lib/http.ts';
import { getHead, readRaw } from '@/lib/branch.ts';
import { audioPaths, audioType, isJobId, jobBranch } from '@/lib/jobs.ts';
import { gh } from '@/lib/env.ts';

// Звук для прослушивания в редакторе (музыка и звуки появления из edit.json) с головы ветки: от папки задачи, потом
// из assets/ — как его находит движок. С `v` (голова ветки) ответ кэшируется браузером — содержимое коммита неизменно.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const rel = url.searchParams.get('path') ?? '';
    const paths = isJobId(id) ? audioPaths(id, rel) : [];
    if (!paths.length) return NextResponse.json({ error: 'bad path' }, { status: 400 });
    const type = audioType(paths[0]);
    if (!type) return NextResponse.json({ error: 'not a sound' }, { status: 415 });
    const g = gh();
    const v = url.searchParams.get('v');
    const ref = v && /^[0-9a-f]{40}$/.test(v) ? v : await getHead(g, jobBranch(id));
    for (const path of ref ? paths : []) {
      const r = await readRaw(g, ref as string, path);
      if (!r) continue;
      return new Response(r.body, {
        headers: { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...commitCache(v) },
      });
    }
    return NextResponse.json({ error: 'Файла нет' }, { status: 404 });
  } catch (e) {
    return errorResponse(e);
  }
}
