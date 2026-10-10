import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/http.ts';
import { getHead } from '@/lib/branch.ts';
import { assetDownload } from '@/lib/github.ts';
import { isJobId, jobBranch } from '@/lib/jobs.ts';
import { readJobFiles } from '@/lib/jobview.ts';
import { gh } from '@/lib/env.ts';

// Готовый ролик или субтитры: id ассета — из out/released.json ветки; 302 на короткоживущую подписанную ссылку
// GitHub (только чтение одного файла) — токен остаётся на сервере.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const name = new URL(request.url).searchParams.get('name') ?? '';
    if (!isJobId(id) || !/^final(-v\d{1,3})?\.(mp4|srt)$/.test(name)) return NextResponse.json({ error: 'bad name' }, { status: 400 });
    const g = gh();
    const head = await getHead(g, jobBranch(id));
    const files = head ? await readJobFiles(g, id, head, 'list') : null;
    const asset = files?.released?.assets.find((a) => a.name === name);
    if (!asset) return NextResponse.json({ error: 'Такого файла нет' }, { status: 404 });
    const d = await assetDownload(g, asset.id);
    if ('location' in d) return NextResponse.redirect(d.location, 302);
    return new Response(d.response.body, {
      headers: {
        'Content-Type': name.endsWith('.srt') ? 'application/x-subrip; charset=utf-8' : 'video/mp4',
        'Content-Disposition': `attachment; filename="${name}"`,
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
