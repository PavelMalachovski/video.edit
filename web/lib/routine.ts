// Запуск шага рутины Claude Code (Routines API). Единственное место с бета-заголовком: если API поменяется,
// чинить только здесь. В тексте запуска — только JSON {job, step, attempt}: всё содержимое задачи сессия читает
// из GitHub, а текст запуска её промпт считает данными, не инструкциями.

export type Step = 'analyze' | 'restyle' | 'render' | 'fix';
export const STEPS: readonly Step[] = ['analyze', 'restyle', 'render', 'fix'];

export type Routine = { id: string; token: string; api?: string; fetch?: typeof fetch };

/** Ошибка запуска: понятный текст для Павла; status — ответ API (0 — нет связи). Токена в тексте не бывает. */
export class RoutineError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'RoutineError';
    this.status = status;
  }
}

export function fireText(job: string, step: Step, attempt: number): string {
  return JSON.stringify({ job, step, attempt });
}

function readable(status: number, body: string, token: string): string {
  if (status === 401 || status === 403) return 'Рутина отклонила запуск: проверьте ROUTINE_TOKEN в Vercel';
  if (status === 404) return 'Рутина не найдена: проверьте ROUTINE_ID';
  if (status === 429) return 'Лимит запусков рутины (30 в час) — повторите позже';
  return `Рутина ответила ${status}: ${hide(body, token).slice(0, 300)}`;
}

function hide(text: string, token: string): string {
  return token ? text.split(token).join('***') : text;
}

export async function fireRoutine(r: Routine, job: string, step: Step, attempt: number): Promise<{ sessionId: string; sessionUrl: string }> {
  if (!STEPS.includes(step)) throw new RoutineError(0, `Неизвестный шаг: ${String(step)}`);
  const api = r.api ?? 'https://api.anthropic.com';
  let response: Response;
  try {
    response = await (r.fetch ?? fetch)(`${api}/v1/claude_code/routines/${r.id}/fire`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${r.token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: fireText(job, step, attempt) }),
    });
  } catch (e) {
    const why = hide(e instanceof Error ? e.message : String(e), r.token);
    throw new RoutineError(0, `Нет связи с api.anthropic.com: ${why}`);
  }
  const body = await response.text();
  if (!response.ok) throw new RoutineError(response.status, readable(response.status, body, r.token));
  let data: { claude_code_session_id?: unknown; claude_code_session_url?: unknown };
  try {
    data = JSON.parse(body);
  } catch {
    throw new RoutineError(response.status, readable(response.status, body, r.token));
  }
  if (typeof data.claude_code_session_id !== 'string' || typeof data.claude_code_session_url !== 'string') {
    throw new RoutineError(response.status, `Рутина ответила без сессии: ${hide(body, r.token).slice(0, 300)}`);
  }
  return { sessionId: data.claude_code_session_id, sessionUrl: data.claude_code_session_url };
}
