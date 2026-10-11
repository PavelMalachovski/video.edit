import { NextResponse } from 'next/server';
import { checkLogo, parseBrand, readBrand, saveBrand, type LogoUpload } from '@/lib/brand.ts';
import { gh } from '@/lib/env.ts';
import { errorResponse } from '@/lib/http.ts';

export const maxDuration = 60;

// «Мой бренд»: GET — сохранённый бренд (и версия логотипа для его адреса), PUT — сохранить. В теле PUT — поля бренда и
// `logo`: {type, base64} — новый логотип, null — убрать, нет поля — оставить прежний.
export async function GET() {
  try {
    const found = await readBrand(gh());
    return NextResponse.json({ brand: found?.brand ?? null, logoVersion: found?.logoSha ?? null });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Пустой запрос' }, { status: 400 });
    const parsed = parseBrand(body);
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    let logo: LogoUpload | null | undefined;
    if (body.logo === null) logo = null;
    else if (body.logo !== undefined) {
      const l = body.logo as Partial<LogoUpload>;
      logo = { type: String(l.type ?? ''), base64: String(l.base64 ?? '') };
      const why = checkLogo(logo);
      if (why) return NextResponse.json({ error: why }, { status: 400 });
    }
    const g = gh();
    const brand = await saveBrand(g, parsed.brand, logo);
    return NextResponse.json({ brand, logoVersion: (await readBrand(g))?.logoSha ?? null });
  } catch (e) {
    return errorResponse(e);
  }
}
