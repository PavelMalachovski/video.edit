import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/http.ts';
import { listAllAssets, uploadAsset } from '@/lib/github.ts';
import type { UploadClaim } from '@/lib/jobfiles.ts';
import { CHUNK_SIZE, checkInsert, checkTotal, isJobId, isUploadFile, MAX_BRIEF, MAX_INSERTS, verifyParts } from '@/lib/jobs.ts';
import { gh } from '@/lib/env.ts';

export const maxDuration = 60;

type Done = { releaseId: number; name: string; size: number; type: string; lastModified: number; parts: number;
  userAgent?: string; startedAt?: number; finishedAt?: number; retries?: number;
  brief?: string; duration?: number | null; uploads?: UploadClaim[] };

// Проверка: все куски исходника и вставок на месте и размеры совпадают → manifest.json в черновик
// (с ТЗ, длительностью и списком вставок — из него страница соберёт job.json при запуске анализа).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const d = (await request.json()) as Done;
    if (!isJobId(id) || !Number.isInteger(d.releaseId)) return NextResponse.json({ error: 'bad request' }, { status: 400 });
    const brief = typeof d.brief === 'string' ? d.brief.trim() : '';
    if (brief.length > MAX_BRIEF) return NextResponse.json({ error: `ТЗ длиннее ${MAX_BRIEF} знаков` }, { status: 413 });
    const uploads = Array.isArray(d.uploads) ? d.uploads : [];
    if (uploads.length > MAX_INSERTS) return NextResponse.json({ error: `Вставок больше ${MAX_INSERTS}` }, { status: 413 });
    for (const u of uploads) {
      if (!u || typeof u.asset !== 'string' || !isUploadFile(u.asset) || !u.asset.startsWith('upload-i')) {
        return NextResponse.json({ error: 'bad upload' }, { status: 400 });
      }
      const why = checkInsert({ name: String(u.name), size: Number(u.size), type: String(u.type) });
      if (why) return NextResponse.json({ error: why }, { status: 413 });
    }
    const total = checkTotal(d.size, uploads.map((u) => u.size));
    if (total) return NextResponse.json({ error: total }, { status: 413 });

    const g = gh();
    const assets = await listAllAssets(g, d.releaseId);
    const source = verifyParts(assets, 'source', d.parts, d.size);
    if (source.missing.length || source.total !== d.size) {
      return NextResponse.json({ ok: false, file: 'source', missing: source.missing, total: source.total, expected: d.size }, { status: 409 });
    }
    for (const u of uploads) {
      const got = verifyParts(assets, u.asset, u.parts, u.size);
      if (got.missing.length || got.total !== u.size) {
        return NextResponse.json({ ok: false, file: u.asset, name: u.name, missing: got.missing, total: got.total, expected: u.size }, { status: 409 });
      }
    }
    const duration = typeof d.duration === 'number' && Number.isFinite(d.duration) && d.duration > 0 ? d.duration : null;
    const manifest = { job: id, name: d.name, size: d.size, type: d.type, lastModified: d.lastModified, parts: d.parts,
      chunkSize: CHUNK_SIZE, userAgent: d.userAgent ?? '', startedAt: d.startedAt, finishedAt: d.finishedAt, retries: d.retries ?? 0,
      completedAt: new Date().toISOString(), brief, duration,
      uploads: uploads.map((u) => ({ asset: u.asset, name: u.name, size: u.size, type: u.type, parts: u.parts })) };
    await uploadAsset(g, d.releaseId, 'manifest.json', new TextEncoder().encode(JSON.stringify(manifest, null, 1)), 'application/json');
    return NextResponse.json({ ok: true, total: source.total });
  } catch (e) {
    return errorResponse(e);
  }
}
