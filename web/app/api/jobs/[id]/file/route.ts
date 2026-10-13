import { NextResponse } from 'next/server';
import { commitCache, errorResponse } from '@/lib/http.ts';
import { getHead, readRaw } from '@/lib/branch.ts';
import { audioPaths, imageType, isJobId, jobBranch, resolveJobPath } from '@/lib/jobs.ts';
import { gh } from '@/lib/env.ts';

// Картинка задачи (кадр превью, картинки к вопросам, ассеты, вставки и логотип для слоя редактора) с головы ветки:
// путь от папки задачи, потом от корня репозитория — но отсюда отдаётся только assets/ (как картинку находит движок,
// render._resolve). Только растровые картинки внутри jobs/<id>/ или assets/; с `v` (голова ветки) ответ кэшируется
// браузером — содержимое коммита неизменно.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const rel = url.searchParams.get('path') ?? '';
    const first = isJobId(id) ? resolveJobPath(id, rel) : null;
    const paths = first ? [...new Set([first, ...audioPaths(id, rel)])] : [];
    if (!paths.length) return NextResponse.json({ error: 'bad path' }, { status: 400 });
    const type = imageType(first as string);
    if (!type) return NextResponse.json({ error: 'not an image' }, { status: 415 });
    const g = gh();
    const v = url.searchParams.get('v');
    const ref = v && /^[0-9a-f]{40}$/.test(v) ? v : await getHead(g, jobBranch(id));
    let r: Response | null = null;
    for (const path of ref ? paths : []) {
      r = await readRaw(g, ref as string, path);
      if (r) break;
    }
    if (!r) return NextResponse.json({ error: 'Файла нет' }, { status: 404 });
    return new Response(r.body, {
      headers: { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...commitCache(v) },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
