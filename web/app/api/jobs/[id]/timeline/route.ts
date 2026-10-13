import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/http.ts';
import { saveTimeline } from '@/lib/editordata.ts';
import { isJobId } from '@/lib/jobs.ts';
import { gh } from '@/lib/env.ts';

export const maxDuration = 30;

// Правки руками из редактора → timeline.json в ветке задачи (ревизия + 1, без force). Другая ревизия в ветке — 409 с
// тем, что там лежит: редактор предлагает загрузить свежие правки.
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isJobId(id)) return NextResponse.json({ error: 'bad job id' }, { status: 400 });
    const body = await request.json().catch(() => null);
    const r = await saveTimeline(gh(), id, body, new Date());
    if (!r.ok) return NextResponse.json({ error: r.error, rev: r.rev, timeline: r.timeline }, { status: r.status });
    return NextResponse.json({ timeline: r.timeline }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return errorResponse(e);
  }
}
