// Округление как у Python (движок): round(x) — к ближайшему целому, ровно половина — к чётному; round(x, n) — по точному
// двоичному значению числа, половина — к чётной цифре. Math.round и toFixed округляют половину вверх — на кадре ровно
// посередине (0,35 с · 30 = 10,5) превью и финал разошлись бы на кадр.

/** round(x) Python: ближайшее целое, ровно половина — к чётному. */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

const view = new DataView(new ArrayBuffer(8));

/** round(x, n) Python для n ≥ 0: десятичное округление точного значения double (половина — к чётной цифре) и обратно в
 *  ближайший double. */
export function pyRound(x: number, n: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const negative = hi >>> 31 === 1;
  const biased = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp: number; // x = ±mantissa · 2^exp
  if (biased === 0) exp = -1074;
  else {
    mantissa |= 1n << 52n;
    exp = biased - 1075;
  }
  const scaled = mantissa * 10n ** BigInt(n);
  let q: bigint;
  if (exp >= 0) q = scaled << BigInt(exp);
  else {
    const den = 1n << BigInt(-exp);
    q = scaled / den;
    const twice = (scaled % den) * 2n;
    if (twice > den || (twice === den && q % 2n === 1n)) q += 1n;
  }
  const out = Number(`${q}e-${n}`);
  return negative ? -out : out;
}
