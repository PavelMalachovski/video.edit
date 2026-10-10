import type { GH } from '../lib/github.ts';
import type { Routine } from '../lib/routine.ts';
import { startFake, type Fake } from './e2e/fake-github.mjs';

// Поддельный fetch для тестов клиентов GitHub и рутины: обработчик видит запрос и отвечает статусом, JSON или
// текстом и заголовками; все вызовы копятся в `calls`.
export type Call = { method: string; url: string; body?: unknown; headers: Headers; redirect?: RequestRedirect };
export type Reply = { status: number; json?: unknown; text?: string; headers?: Record<string, string> };

export function fakeFetch(handler: (c: Call) => Reply): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const c: Call = { method: init?.method ?? 'GET', url: String(url), body: init?.body, headers: new Headers(init?.headers), redirect: init?.redirect };
    calls.push(c);
    const r = handler(c);
    const body = r.text ?? (r.json === undefined ? null : JSON.stringify(r.json));
    return new Response(r.status === 204 || r.status === 304 ? null : body, { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return { fetch: f, calls };
}

/** Поддельный GitHub (git, релизы, рутина) на случайном порту на время `fn`; клиенты уже смотрят на него. */
export async function withFake(fn: (x: { fake: Fake; gh: GH; routine: Routine }) => Promise<void>): Promise<void> {
  const fake = await startFake();
  try {
    await fn({
      fake,
      gh: { token: 't', repo: 'o/r', api: `${fake.url}/api`, uploads: `${fake.url}/up` },
      routine: { id: 'trig_t', token: 'rt', api: fake.url },
    });
  } finally {
    await fake.close();
  }
}

