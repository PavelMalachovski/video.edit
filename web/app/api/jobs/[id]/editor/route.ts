import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/http.ts';
import { loadEditor } from '@/lib/editordata.ts';
import { isJobId } from '@/lib/jobs.ts';
import { gh } from '@/lib/env.ts';

// Редактор (бета): черновик монтажа, файлы редактора и ссылки на прокси и ленту кадров с головы ветки.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isJobId(id)) return NextResponse.json({ error: 'bad job id' }, { status: 400 });
    const data = await loadEditor(gh(), id);
    if (!data) return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 });
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return errorResponse(e);
  }
}
