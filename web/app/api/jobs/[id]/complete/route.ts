import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/http.ts';
import { listAllAssets, uploadAsset } from '@/lib/github.ts';
import type { UploadClaim } from '@/lib/jobfiles.ts';
import {
  CHUNK_SIZE, checkCharacter, checkTotal, checkUploadClaims, checkVideos, isJobId, MAX_BRIEF, verifyParts,
} from '@/lib/jobs.ts';
import { gh } from '@/lib/env.ts';

export const maxDuration = 60;

type Done = { releaseId: number; name: string; size: number; type: string; lastModified: number; parts: number;
  userAgent?: string; startedAt?: number; finishedAt?: number; retries?: number;
  brief?: string; duration?: number | null; uploads?: UploadClaim[];
  videos?: unknown; character?: unknown }; // character — разбор персонажа (фильм, персонаж, актёр); нет — обычный ролик // несколько видео — все по порядку (первое — то же, что name, size, parts); одно — нет поля

// Проверка: все куски видео, вставок и озвучки на месте и размеры совпадают → manifest.json в черновик
// (с ТЗ, длительностью, списком видео, вставок и озвучки — из него страница соберёт job.json при запуске анализа).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const d = (await request.json()) as Done;
    const releaseId = typeof d.releaseId === 'number' ? Number(d.releaseId) : NaN; // в адрес GitHub — только число
    if (!isJobId(id) || !Number.isInteger(releaseId)) return NextResponse.json({ error: 'bad request' }, { status: 400 });
    const brief = typeof d.brief === 'string' ? d.brief.trim() : '';
    if (brief.length > MAX_BRIEF) return NextResponse.json({ error: `ТЗ длиннее ${MAX_BRIEF} знаков` }, { status: 413 });
    const breakdown = checkCharacter(d.character);
    if ('error' in breakdown) return NextResponse.json({ error: breakdown.error }, { status: 400 });
    const uploads = Array.isArray(d.uploads) ? d.uploads : [];
    const bad = checkUploadClaims(uploads);
    if (bad) return NextResponse.json({ error: bad.error }, { status: bad.status });
    const listed = checkVideos(d.videos, { name: d.name, size: d.size, parts: d.parts });
    if ('error' in listed) return NextResponse.json({ error: listed.error }, { status: 400 });
    const more = (listed.videos ?? []).slice(1); // видео после первого — куски считаются, как у вставок
    const total = checkTotal(d.size, [...more.map((v) => v.size), ...uploads.map((u) => u.size)]);
    if (total) return NextResponse.json({ error: total }, { status: 413 });

    const g = gh();
    const assets = await listAllAssets(g, releaseId);
    const source = verifyParts(assets, 'source', d.parts, d.size);
    if (source.missing.length || source.total !== d.size) {
      return NextResponse.json({ ok: false, file: 'source', missing: source.missing, total: source.total, expected: d.size }, { status: 409 });
    }
    for (const u of [...more, ...uploads]) {
      const got = verifyParts(assets, u.asset, u.parts, u.size);
      if (got.missing.length || got.total !== u.size) {
        return NextResponse.json({ ok: false, file: u.asset, name: u.name, missing: got.missing, total: got.total, expected: u.size }, { status: 409 });
      }
    }
    const duration = typeof d.duration === 'number' && Number.isFinite(d.duration) && d.duration > 0 ? d.duration : null;
    const manifest = { job: id, name: d.name, size: d.size, type: d.type, lastModified: d.lastModified, parts: d.parts,
      chunkSize: CHUNK_SIZE, userAgent: d.userAgent ?? '', startedAt: d.startedAt, finishedAt: d.finishedAt, retries: d.retries ?? 0,
      completedAt: new Date().toISOString(), brief, duration,
      uploads: uploads.map((u) => ({ asset: u.asset, name: u.name, size: u.size, type: u.type, parts: u.parts })),
      ...(listed.videos ? { videos: listed.videos } : {}),
      ...(breakdown.character ? { format: 'character', character: breakdown.character } : {}) };
    await uploadAsset(g, releaseId, 'manifest.json', new TextEncoder().encode(JSON.stringify(manifest, null, 1)), 'application/json');
    return NextResponse.json({ ok: true, total: source.total });
  } catch (e) {
    return errorResponse(e);
  }
}
