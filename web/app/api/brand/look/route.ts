import { NextResponse } from 'next/server';
import { lookFromJob, saveLook } from '@/lib/brand.ts';
import { readText } from '@/lib/branch.ts';
import { gh } from '@/lib/env.ts';
import { errorResponse } from '@/lib/http.ts';
import { isJobId, jobBranch, jobDir } from '@/lib/jobs.ts';

export const maxDuration = 60;

// «Мой стиль» в бренде: POST {job} — сохранить, как смонтирован этот ролик (стиль, скорость, затемнение, музыка — из его
// ветки, а не из запроса), DELETE — убрать. Новые задачи берут его с копией бренда.
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { job?: unknown } | null;
    const id = typeof body?.job === 'string' ? body.job : '';
    if (!isJobId(id)) return NextResponse.json({ error: 'Нет такой задачи' }, { status: 400 });
    const g = gh();
    const read = async (name: string) => {
      const text = await readText(g, jobBranch(id), `${jobDir(id)}/${name}`);
      try {
        return text === null ? null : (JSON.parse(text) as Record<string, unknown>);
      } catch {
        return null;
      }
    };
    const [answers, edit, timeline, job] = await Promise.all(['answers.json', 'edit.json', 'timeline.json', 'job.json'].map(read));
    const title = typeof job?.name === 'string' ? job.name : id;
    const look = lookFromJob({ answers, edit, timeline }, { job: id, title, at: new Date().toISOString() });
    if (!look) return NextResponse.json({ error: 'У ролика ещё нет стиля — выберите его на превью' }, { status: 409 });
    await saveLook(g, look);
    return NextResponse.json({ look });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE() {
  try {
    await saveLook(gh(), null);
    return NextResponse.json({ look: null });
  } catch (e) {
    return errorResponse(e);
  }
}
