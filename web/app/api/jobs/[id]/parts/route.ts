import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/http.ts';
import { listAllAssets } from '@/lib/github.ts';
import { isJobId } from '@/lib/jobs.ts';
import { gh } from '@/lib/env.ts';

// Уже загруженные куски черновика — чтобы после перезагрузки страницы дослать только недостающие.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const releaseId = Number(new URL(request.url).searchParams.get('release'));
    if (!isJobId(id) || !Number.isInteger(releaseId) || releaseId <= 0) return NextResponse.json({ error: 'bad request' }, { status: 400 });
    const assets = await listAllAssets(gh(), releaseId);
    return NextResponse.json(assets.filter((a) => /\.part-\d{5}$/.test(a.name)).map((a) => ({ name: a.name, size: a.size })));
  } catch (e) {
    return errorResponse(e);
  }
}
