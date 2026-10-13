// Вход по одному паролю: подписанная cookie `${exp}.${hmac(exp)}`, 30 дней.
// Только Web Crypto — работает и в proxy.ts, и в обработчиках маршрутов.
export const SESSION_COOKIE = 'vm_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
  return Buffer.from(sig).toString('base64url');
}

export async function signSession(secret: string, now: number = Date.now()): Promise<string> {
  const exp = String(now + SESSION_TTL_MS);
  return `${exp}.${await hmac(secret, exp)}`;
}

export async function verifySession(token: string | undefined, secret: string, now: number = Date.now()): Promise<boolean> {
  if (!token || !secret) return false;
  const [exp, sig, extra] = token.split('.');
  if (!exp || !sig || extra !== undefined || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < now) return false;
  const want = await hmac(secret, exp);
  if (want.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/** Запрос с действующей cookie входа — для маршрутов, мимо которых proxy.ts не ходит (куски загрузки: иначе Vercel считал
 *  бы их трафик дважды). */
export async function authorized(request: Request): Promise<boolean> {
  const cookie = (request.headers.get('cookie') ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return verifySession(cookie?.slice(SESSION_COOKIE.length + 1), process.env.SESSION_SECRET ?? '');
}
