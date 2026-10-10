import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/http.ts';
import { isJobId } from '@/lib/jobs.ts';
import { canRun, loadJob } from '@/lib/jobview.ts';
import { deleteJob } from '@/lib/steps.ts';
import { gh } from '@/lib/env.ts';

// Экран задачи: состояние и файлы сессии на голове ветки (страница опрашивает раз в ~5 с).
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isJobId(id)) return NextResponse.json({ error: 'bad job id' }, { status: 400 });
    const g = gh();
    const loaded = await loadJob(g, id, 'all');
    if (!loaded) return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 });
    const f = loaded.files;
    return NextResponse.json({
      view: loaded.view,
      questions: f?.questions ?? null,
      styles: f?.styles ?? null,
      answers: f?.answers ?? null,
      result: f?.result ?? null,
      fixes: f?.fix?.fixes ?? [],
      restyles: f?.restyle?.requests ?? [],
      uploads: f?.job?.uploads ?? [],
      repo: g.repo,
      head: f?.head ?? null,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

// «Удалить»: ветку и черновик с видео (токеном Павла на сервере); пока Claude работает — нельзя.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isJobId(id)) return NextResponse.json({ error: 'bad job id' }, { status: 400 });
    const g = gh();
    const loaded = await loadJob(g, id, 'list');
    if (!loaded) return NextResponse.json({ ok: true });
    const why = canRun(loaded.view, 'delete');
    if (why) return NextResponse.json({ error: why }, { status: 409 });
    await deleteJob(g, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

