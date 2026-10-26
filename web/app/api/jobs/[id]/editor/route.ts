import { NextResponse } from 'next/server';
import { errorResponse, jsonWithEtag } from '@/lib/http.ts';
import { loadEditor } from '@/lib/editordata.ts';
import { isJobId } from '@/lib/jobs.ts';
import { gh } from '@/lib/env.ts';
import { deliverLater } from '../../deliver.ts';

export const maxDuration = 60; // и перенос готовых файлов после ответа (deliverLater)

// Редактор (бета): черновик монтажа, файлы редактора и ссылки на прокси и ленту кадров с головы ветки; прокси и прокси
// перебивок, оставленные сессией в ветке, переносятся в черновик (deliverLater).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isJobId(id)) return NextResponse.json({ error: 'bad job id' }, { status: 400 });
    const g = gh();
    const data = await loadEditor(g, id);
    if (!data) return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 });
    deliverLater(g, id, data.outputs);
    return jsonWithEtag(data, request); // опрос редактора с тем же содержимым — 304 без тела
  } catch (e) {
    return errorResponse(e);
  }
}
