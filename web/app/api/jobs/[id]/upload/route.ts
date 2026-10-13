import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/http.ts';
import { isUploadPicture, pictureType, uploadParts } from '@/lib/editordata.ts';
import { assetDownload, listAllAssets } from '@/lib/github.ts';
import { isJobId } from '@/lib/jobs.ts';
import { loadJob } from '@/lib/jobview.ts';
import { gh } from '@/lib/env.ts';

// Картинка, которую Павел загрузил к ролику (вставка к ролику, картинка к ответу), — для слоя кадра в редакторе: она в
// черновике релиза задачи (в ветку её не кладут) — кусками `<имя>.part-NNNNN`, как их кладёт загрузка. Один кусок
// (обычное фото до 4 МБ) — 302 на короткоживущую подписанную ссылку GitHub; несколько — склеиваем по порядку здесь.
// Токен остаётся на сервере.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const name = new URL(request.url).searchParams.get('name') ?? '';
    if (!isJobId(id) || !isUploadPicture(name)) return NextResponse.json({ error: 'bad name' }, { status: 400 });
    const g = gh();
    const loaded = await loadJob(g, id, 'list');
    if (!loaded) return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 });
    // куски — из полного списка: в первой странице ассетов их может быть не все (картинка вышла бы обрезанной)
    const parts = uploadParts(await listAllAssets(g, loaded.release.id), name);
    if (!parts) return NextResponse.json({ error: 'Такой картинки нет' }, { status: 404 });
    if (parts.length === 1) {
      const d = await assetDownload(g, parts[0].id);
      if ('location' in d) return NextResponse.redirect(d.location, { status: 302, headers: { 'Cache-Control': 'no-store' } });
      return new Response(d.response.body, { headers: { 'Content-Type': pictureType(name), 'Cache-Control': 'no-store' } });
    }
    const chunks: Uint8Array[] = []; // картинка — не больше 20 МБ (MAX_ANSWER_IMAGE_BYTES): кусками по порядку
    for (const part of parts) {
      const d = await assetDownload(g, part.id);
      const r = 'location' in d ? await fetch(d.location) : d.response;
      if (!r.ok) throw new Error(`кусок ${part.name}: ${r.status}`);
      chunks.push(new Uint8Array(await r.arrayBuffer()));
    }
    return new Response(new Blob(chunks as BlobPart[]), { headers: { 'Content-Type': pictureType(name), 'Cache-Control': 'no-store' } });
  } catch (e) {
    return errorResponse(e);
  }
}
