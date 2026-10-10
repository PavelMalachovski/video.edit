import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/http.ts';
import { listAllAssets, uploadAsset } from '@/lib/github.ts';
import { CHUNK_SIZE, isJobId, partName } from '@/lib/jobs.ts';
import { gh } from '@/lib/env.ts';

export const maxDuration = 60;

type Done = { releaseId: number; name: string; size: number; type: string; lastModified: number; parts: number;
  userAgent?: string; startedAt?: number; finishedAt?: number; retries?: number };

// Проверка: все куски на месте и сумма размеров совпадает → manifest.json в черновик.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const d = (await request.json()) as Done;
    if (!isJobId(id) || !Number.isInteger(d.releaseId)) return NextResponse.json({ error: 'bad request' }, { status: 400 });
    const g = gh();
    const assets = await listAllAssets(g, d.releaseId);
    const byName = new Map(assets.map((a) => [a.name, a]));
    const missing: number[] = [];
    let total = 0;
    for (let i = 0; i < d.parts; i++) {
      const a = byName.get(partName(i));
      if (!a) missing.push(i); else total += a.size;
    }
    if (missing.length || total !== d.size) {
      return NextResponse.json({ ok: false, missing, total, expected: d.size }, { status: 409 });
    }
    const manifest = { job: id, name: d.name, size: d.size, type: d.type, lastModified: d.lastModified, parts: d.parts,
      chunkSize: CHUNK_SIZE, userAgent: d.userAgent ?? '', startedAt: d.startedAt, finishedAt: d.finishedAt, retries: d.retries ?? 0,
      completedAt: new Date().toISOString() };
    await uploadAsset(g, d.releaseId, 'manifest.json', new TextEncoder().encode(JSON.stringify(manifest, null, 1)), 'application/json');
    return NextResponse.json({ ok: true, total });
  } catch (e) {
    return errorResponse(e);
  }
}
