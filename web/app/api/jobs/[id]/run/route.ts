import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/http.ts';
import { listAllAssets } from '@/lib/github.ts';
import { editorFix, TIMELINE, timelineOf } from '@/lib/editordata.ts';
import { answersFile, appendFix, appendRestyle, parseAnswersBody, parseNote } from '@/lib/jobfiles.ts';
import { isJobId, verifyParts } from '@/lib/jobs.ts';
import { canRun, loadJob, readJobText, type Action } from '@/lib/jobview.ts';
import { backStep, retryStep, runStep, startJob, type Deps } from '@/lib/steps.ts';
import { gh, routine } from '@/lib/env.ts';

export const maxDuration = 30;

const json = (data: unknown): string => `${JSON.stringify(data, null, 2)}\n`;
const ACTIONS: Action[] = ['start', 'answers', 'restyle', 'fix', 'retry', 'back'];

// Действие на странице задачи → шаг рутины. Можно ли сейчас — решает canRun по состоянию ветки.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as { action?: string } | null;
    const action = body?.action as Action | undefined;
    if (!isJobId(id) || !action || !ACTIONS.includes(action)) return NextResponse.json({ error: 'bad request' }, { status: 400 });
    const d: Deps = { gh: gh(), routine: routine() };
    const loaded = await loadJob(d.gh, id, 'all');
    if (!loaded) return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 });
    const why = canRun(loaded.view, action);
    if (why) return NextResponse.json({ error: why }, { status: 409 });
    const files = loaded.files;
    if (action === 'start') return NextResponse.json(await startJob(d, id));
    if (action === 'retry') return NextResponse.json(await retryStep(d, id));
    if (action === 'back') return NextResponse.json(await backStep(d, id));
    if (action === 'answers') {
      const parsed = parseAnswersBody(body, files?.questions ?? []);
      if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
      const claims = Object.values(parsed.uploads);
      if (claims.length) {
        const assets = await listAllAssets(d.gh, loaded.release.id);
        for (const c of claims) {
          const { missing, total } = verifyParts(assets, c.asset, c.parts, c.size);
          if (missing.length || total !== c.size) {
            return NextResponse.json({ error: `Картинка ${c.name} не догрузилась — выберите её ещё раз` }, { status: 409 });
          }
        }
      }
      if (!files?.job) return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 });
      return NextResponse.json(await runStep(d, id, 'render', { 'answers.json': json(answersFile(parsed, files.job)) }));
    }
    if (action === 'fix' && body && 'editor' in body) { // «Монтировать» из редактора: правки руками и стиль
      const head = files?.head ?? null;
      const { rev } = timelineOf(head ? await readJobText(d.gh, id, head, TIMELINE) : null);
      const r = editorFix(body, { rev, answers: files?.answers ?? null, fix: files?.fix ?? null }, new Date());
      if ('error' in r) return NextResponse.json({ error: r.error }, { status: r.status });
      return NextResponse.json(await runStep(d, id, 'fix', r.files));
    }
    const text = parseNote(body);
    if (typeof text !== 'string') return NextResponse.json({ error: text.error }, { status: 400 });
    if (action === 'restyle') {
      return NextResponse.json(await runStep(d, id, 'restyle', { 'restyle.json': json(appendRestyle(files?.restyle ?? null, text, new Date())) }));
    }
    return NextResponse.json(await runStep(d, id, 'fix', { 'fix.json': json(appendFix(files?.fix ?? null, text, new Date())) }));
  } catch (e) {
    return errorResponse(e);
  }
}
