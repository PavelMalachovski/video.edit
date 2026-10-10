import { NextResponse } from 'next/server';
import { env } from '@/lib/env.ts';

// Проверка рутины: запуск по API. Тело ответа API возвращается как есть.
export async function POST(request: Request) {
  const { job } = (await request.json().catch(() => ({}))) as { job?: string };
  const id = job && /^[a-z0-9-]{1,40}$/.test(job) ? job : `spike-${Date.now().toString(36)}`;
  const t = Date.now();
  const r = await fetch(`https://api.anthropic.com/v1/claude_code/routines/${env('ROUTINE_ID')}/fire`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env('ROUTINE_TOKEN')}`,
      'anthropic-beta': 'experimental-cc-routine-2026-04-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: JSON.stringify({ job: id, step: 'spike', attempt: 1 }) }),
  });
  const text = await r.text();
  return NextResponse.json({ job: id, firedAt: new Date(t).toISOString(), ms: Date.now() - t, status: r.status, response: text.slice(0, 4000) });
}
