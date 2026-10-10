import type { GH } from './github.ts';

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`env ${name} is not set`);
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
