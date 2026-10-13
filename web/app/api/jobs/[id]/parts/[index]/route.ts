import { NextResponse } from 'next/server';
import { authorized } from '@/lib/auth.ts';
import { uploadAsset } from '@/lib/github.ts';
import { errorResponse } from '@/lib/http.ts';
import { CHUNK_SIZE, chunkName, isJobId, isSourceFile, isUploadFile, MAX_ANSWER_IMAGE_BYTES, partsOf } from '@/lib/jobs.ts';
import { gh } from '@/lib/env.ts';

export const maxDuration = 60;

// Один кусок (≤ 4 МБ) видео или вставки → ассет <file>.part-NNNNN черновика job-<id> (file — source, source-2… или upload-*).
export async function PUT(request: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  // proxy.ts этот маршрут пропускает (тело куска иначе считалось бы в трафик Vercel дважды) — вход проверяем здесь,
  // до чтения тела
  if (!(await authorized(request))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id, index } = await params;
  const query = new URL(request.url).searchParams;
  const releaseId = Number(query.get('release'));
  const file = query.get('file') ?? 'source';
  const n = Number(index);
  if (!isJobId(id) || !Number.isInteger(n) || n < 0 || !Number.isInteger(releaseId) || releaseId <= 0 || (!isSourceFile(file) && !isUploadFile(file))) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  if (file.startsWith('upload-q-') && n >= partsOf(MAX_ANSWER_IMAGE_BYTES)) {
    return NextResponse.json({ error: 'Картинка к ответу больше 20 МБ' }, { status: 413 });
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length === 0 || body.length > CHUNK_SIZE) {
    return NextResponse.json({ error: `chunk size ${body.length}` }, { status: 413 });
  }
  const t = Date.now();
  try {
    const a = await uploadAsset(gh(), releaseId, chunkName(file, n), body);
    return NextResponse.json({ name: a.name, size: a.size, ms: Date.now() - t });
  } catch (e) {
    return errorResponse(e);  // лимит GitHub → 429 с retryAfter: загрузчик подождёт и повторит
  }
}
