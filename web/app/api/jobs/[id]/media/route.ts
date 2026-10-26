import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/http.ts';
import { getHead } from '@/lib/branch.ts';
import { mediaAsset } from '@/lib/editordata.ts';
import { isJobId, jobBranch } from '@/lib/jobs.ts';
import { releasedDownload } from '@/lib/outputs.ts';
import { readJobFiles } from '@/lib/jobview.ts';
import { gh } from '@/lib/env.ts';

// Видео для редактора (прокси): id ассета — из out/released.json ветки (его там уже нет — по имени из черновика,
// releasedDownload); 302 на короткоживущую подписанную ссылку
// GitHub — она сама отдаёт куски по Range (плеер перематывает), токен остаётся на сервере. Ссылка истекает —
// плеер просит этот адрес снова.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const name = new URL(request.url).searchParams.get('name') ?? '';
    if (!isJobId(id)) return NextResponse.json({ error: 'bad job id' }, { status: 400 });
    const g = gh();
    const head = await getHead(g, jobBranch(id));
    const files = head ? await readJobFiles(g, id, head, 'list') : null;
    const d = mediaAsset(files, name) ? await releasedDownload(g, id, files?.released ?? null, name) : null;
    if (!d) return NextResponse.json({ error: 'Такого файла нет' }, { status: 404 });
    if ('location' in d) return NextResponse.redirect(d.location, { status: 302, headers: { 'Cache-Control': 'no-store' } });
    return new Response(d.response.body, { headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' } });
  } catch (e) {
    return errorResponse(e);
  }
}
