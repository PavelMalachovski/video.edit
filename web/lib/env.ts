import type { GH } from './github.ts';
import type { Routine } from './routine.ts';

/** Сервис не настроен: нет переменной окружения на Vercel. Текст — для Павла: что задать и где. */
export class ConfigError extends Error {
  constructor(name: string) {
    super(`Сервис не настроен: в Vercel нет переменной ${name} (Settings → Environment Variables), после неё — Redeploy`);
    this.name = 'ConfigError';
  }
}

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new ConfigError(name);
  return v;
}

// GITHUB_API_URL / GITHUB_UPLOADS_URL — только для локальной проверки с поддельным GitHub.
export function gh(): GH {
  return {
    token: env('GITHUB_TOKEN'),
    repo: process.env.GITHUB_REPO || 'PavelMalachovski/video.edit',
    api: process.env.GITHUB_API_URL || undefined,
    uploads: process.env.GITHUB_UPLOADS_URL || undefined,
  };
}

// ROUTINE_API_URL — только для локальной проверки (поддельный API рутины).
export function routine(): Routine {
  return { id: env('ROUTINE_ID'), token: env('ROUTINE_TOKEN'), api: process.env.ROUTINE_API_URL || undefined };
}
