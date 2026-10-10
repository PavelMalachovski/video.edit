// Числа для людей: длительность m:ss и размер файла — как в макетах («1:42», «184 МБ»).

export function mmss(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function bytes(n: number): string {
  if (n < 1024 ** 2) return `${Math.max(1, Math.round(n / 1024))} КБ`;
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} МБ`;
  return `${(n / 1024 ** 3).toFixed(2).replace('.', ',')} ГБ`;
}
