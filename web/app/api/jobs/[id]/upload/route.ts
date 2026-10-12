import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/http.ts';
import { isUploadPicture } from '@/lib/editordata.ts';
import { assetDownload, listAllAssets } from '@/lib/github.ts';
import { isJobId } from '@/lib/jobs.ts';
import { loadJob } from '@/lib/jobview.ts';
import { gh } from '@/lib/env.ts';

// Картинка, которую Павел загрузил к ролику (вставка к ролику, картинка к ответу), — для слоя кадра в редакторе: она в
// черновике релиза задачи (в ветку её не кладут), отсюда — 302 на короткоживущую подписанную ссылку GitHub; токен
// остаётся на сервере. Только картинки загрузок одним ассетом (большие, кусками, слой не рисует).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const name = new URL(request.url).searchParams.get('name') ?? '';
    if (!isJobId(id) || !isUploadPicture(name)) return NextResponse.json({ error: 'bad name' }, { status: 400 });
    const g = gh();
    const loaded = await loadJob(g, id, 'list');
    if (!loaded) return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 });
    let asset = loaded.release.assets.find((a) => a.name === name);
    if (!asset) asset = (await listAllAssets(g, loaded.release.id)).find((a) => a.name === name); // в первой странице — не все
    if (!asset) return NextResponse.json({ error: 'Такой картинки нет' }, { status: 404 });
    const d = await assetDownload(g, asset.id);
    if ('location' in d) return NextResponse.redirect(d.location, { status: 302, headers: { 'Cache-Control': 'no-store' } });
    return new Response(d.response.body, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } });
  } catch (e) {
    return errorResponse(e);
  }
}
