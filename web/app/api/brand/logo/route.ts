import { NextResponse } from 'next/server';
import { BRAND_BRANCH, BRAND_DIR, readBrand } from '@/lib/brand.ts';
import { readRaw } from '@/lib/branch.ts';
import { gh } from '@/lib/env.ts';
import { errorResponse } from '@/lib/http.ts';
import { imageType } from '@/lib/jobs.ts';

// Логотип бренда из его ветки. С `v` (sha логотипа) ответ кэшируется браузером — новый логотип — новый адрес.
export async function GET(request: Request) {
  try {
    const g = gh();
    const found = await readBrand(g);
    const name = found?.brand.logo;
    const type = name ? imageType(name) : null;
    const r = name && type ? await readRaw(g, BRAND_BRANCH, `${BRAND_DIR}/${name}`) : null;
    if (!r || !type) return NextResponse.json({ error: 'Логотипа нет' }, { status: 404 });
    const v = new URL(request.url).searchParams.get('v');
    return new Response(r.body, {
      headers: {
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': v && v === found?.logoSha ? 'private, max-age=86400' : 'no-store',
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
