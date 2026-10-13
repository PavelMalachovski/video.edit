// Сравнение значений JSON (стиль Павла и т. п.) — одно на странице и на сервере: порядок ключей не важен, поле со
// значением undefined — как поля нет (так его пишет JSON).

export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  }
  const keys = (o: object) => Object.entries(o).filter(([, v]) => v !== undefined).map(([k]) => k);
  const ka = keys(a);
  const kb = keys(b);
  return ka.length === kb.length && ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
