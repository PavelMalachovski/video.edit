import { NextResponse } from 'next/server';
import { errorResponse, jsonWithEtag } from '@/lib/http.ts';
import { loadEditor } from '@/lib/editordata.ts';
import { isJobId } from '@/lib/jobs.ts';
import { gh } from '@/lib/env.ts';

// Редактор (бета): черновик монтажа, файлы редактора и ссылки на прокси и ленту кадров с головы ветки.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isJobId(id)) return NextResponse.json({ error: 'bad job id' }, { status: 400 });
    const data = await loadEditor(gh(), id);
    if (!data) return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 });
    return jsonWithEtag(data, request); // опрос редактора с тем же содержимым — 304 без тела
  } catch (e) {
    return errorResponse(e);
  }
}
