import { NextResponse } from 'next/server';
import { uploadAsset } from '@/lib/github.ts';
import { CHUNK_SIZE, isJobId, partName } from '@/lib/jobs.ts';
import { gh } from '@/lib/env.ts';

export const maxDuration = 60;

// Один кусок исходника (≤ 4 МБ) → ассет source.part-NNNNN черновика job-<id>.
export async function PUT(request: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  const { id, index } = await params;
  const releaseId = Number(new URL(request.url).searchParams.get('release'));
  const n = Number(index);
  if (!isJobId(id) || !Number.isInteger(n) || n < 0 || !Number.isInteger(releaseId) || releaseId <= 0) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length === 0 || body.length > CHUNK_SIZE) {
    return NextResponse.json({ error: `chunk size ${body.length}` }, { status: 413 });
  }
  const t = Date.now();
  try {
    const a = await uploadAsset(gh(), releaseId, partName(n), body);
    return NextResponse.json({ name: a.name, size: a.size, ms: Date.now() - t });
  } catch (e) {
    const msg = String(e);
    const limited = /secondary rate limit|rate limit|abuse/i.test(msg) || / 403 /.test(msg) || / 429 /.test(msg);
    return NextResponse.json({ error: msg.slice(0, 500) }, { status: limited ? 429 : 502 });
  }
}
