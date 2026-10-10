'use client';
// Страница задачи упала при отрисовке (например, файл сессии неожиданной формы): не пустой экран, а понятный текст.
import Link from 'next/link';

export default function JobError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main>
      <Link href="/" className="back">← Мои видео</Link>
      <div className="card bad">
        <b>Страница задачи не открылась</b>
        <div className="muted">Похоже, в файлах задачи что-то не так. Обновите страницу; не поможет — откройте задачу позже или удалите её в «Мои видео».</div>
        <button type="button" className="btn" onClick={reset}>Обновить</button>
      </div>
    </main>
  );
}
