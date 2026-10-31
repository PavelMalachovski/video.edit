import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/http.ts';
import { isJobId } from '@/lib/jobs.ts';
import { loadJob, readJobText } from '@/lib/jobview.ts';
import { askStills, parseStillsBody, stillsKnown, stillsState } from '@/lib/stills.ts';
import { gh, routine } from '@/lib/env.ts';

export const maxDuration = 30;

// «Найти ещё кадры» из редактора: stills.json в ветке задачи и запуск рутины `stills` (vm tmdb --more). Пока идёт
// шаг монтажа, поиск уже идёт или движок задачи его не знает — 409 с причиной.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isJobId(id)) return NextResponse.json({ error: 'bad job id' }, { status: 400 });
    const ask = parseStillsBody(await request.json().catch(() => null));
    if ('error' in ask) return NextResponse.json({ error: ask.error }, { status: 400 });
    const g = gh();
    const loaded = await loadJob(g, id, 'all');
    const head = loaded?.files?.head ?? null;
    if (!loaded || !head) return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 });
    if (loaded.view.screen === 'working') return NextResponse.json({ error: 'Claude сейчас монтирует — поищи кадры, когда он закончит' }, { status: 409 });
    if (!(await stillsKnown(g, head))) {
      return NextResponse.json({ error: 'Эта задача создана до поиска кадров из редактора — кадры здесь ищутся через «Поправить»' }, { status: 409 });
    }
    const json = (text: string | null) => { try { return text === null ? null : JSON.parse(text); } catch { return null; } };
    const [asked, found] = await Promise.all([readJobText(g, id, head, 'stills.json'), readJobText(g, id, head, 'found/tmdb.json')]);
    if (stillsState(true, json(asked), json(found), null).pending) return NextResponse.json({ error: 'Кадры уже ищутся — подожди' }, { status: 409 });
    return NextResponse.json(await askStills({ gh: g, routine: routine() }, id, ask, new Date()));
  } catch (e) {
    return errorResponse(e);
  }
}
