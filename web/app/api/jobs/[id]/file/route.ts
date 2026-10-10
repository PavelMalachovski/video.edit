import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/http.ts';
import { getHead, readRaw } from '@/lib/branch.ts';
import { imageType, isJobId, jobBranch, resolveJobPath } from '@/lib/jobs.ts';
import { gh } from '@/lib/env.ts';

// Картинка задачи (кадр превью, картинки к вопросам, ассеты) с головы ветки. Только растровые картинки внутри
// jobs/<id>/ или assets/; с `v` (голова ветки) ответ кэшируется браузером — содержимое коммита неизменно.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const rel = url.searchParams.get('path') ?? '';
    const path = isJobId(id) ? resolveJobPath(id, rel) : null;
    if (!path) return NextResponse.json({ error: 'bad path' }, { status: 400 });
    const type = imageType(path);
    if (!type) return NextResponse.json({ error: 'not an image' }, { status: 415 });
    const g = gh();
    const v = url.searchParams.get('v');
    const ref = v && /^[0-9a-f]{40}$/.test(v) ? v : await getHead(g, jobBranch(id));
    const r = ref ? await readRaw(g, ref, path) : null;
    if (!r) return NextResponse.json({ error: 'Файла нет' }, { status: 404 });
    return new Response(r.body, {
      headers: {
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': v ? 'private, max-age=86400' : 'no-store',
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
