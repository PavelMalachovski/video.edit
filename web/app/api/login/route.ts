import { NextResponse } from 'next/server';
import { SESSION_COOKIE, SESSION_TTL_MS, signSession } from '@/lib/auth.ts';
import { env } from '@/lib/env.ts';

export async function POST(request: Request) {
  const form = await request.formData();
  // Относительный Location: хост за прокси Vercel и локально может отличаться от request.url.
  if (String(form.get('password') ?? '') !== env('APP_PASSWORD')) {
    return new NextResponse(null, { status: 303, headers: { Location: '/login?e=1' } });
  }
  const res = new NextResponse(null, { status: 303, headers: { Location: '/' } });
  const https = (request.headers.get('x-forwarded-proto') ?? new URL(request.url).protocol.replace(':', '')) === 'https';
  res.cookies.set(SESSION_COOKIE, await signSession(env('SESSION_SECRET')), {
    httpOnly: true, secure: https, sameSite: 'lax', path: '/', maxAge: SESSION_TTL_MS / 1000,
  });
  return res;
}
