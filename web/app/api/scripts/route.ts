import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/http.ts';
import { parseScriptRequest } from '@/lib/script.ts';
import { startScript } from '@/lib/steps.ts';
import { gh, routine } from '@/lib/env.ts';

export const maxDuration = 30;

// «Новый сценарий»: задача без видео и запуск анализа — сессия напишет script.json.
export async function POST(request: Request) {
  try {
    const parsed = parseScriptRequest(await request.json().catch(() => null));
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    return NextResponse.json(await startScript({ gh: gh(), routine: routine() }, parsed));
  } catch (e) {
    return errorResponse(e);
  }
}
