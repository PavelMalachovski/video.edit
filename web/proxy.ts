import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from './lib/auth.ts';

// Всё, кроме входа и статики, — только с подписанной cookie. Куски загрузки видео (PUT …/parts/<n>, по 4 МБ) идут мимо:
// proxy получает и тело запроса, и Vercel считал бы каждый кусок в лимит трафика дважды — вход проверяет сам маршрут.
export async function proxy(request: NextRequest) {
  const ok = await verifySession(request.cookies.get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET ?? '');
  if (ok) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!login|api/login|api/jobs/[^/]+/parts/\\d+$|_next/static|_next/image|favicon.ico).*)'],
};
