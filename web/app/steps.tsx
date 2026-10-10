// Полоса шагов из макетов: где сейчас ролик — от загрузки до монтажа.
export const STEP_NAMES = ['Загрузка', 'Текст', 'Вопросы', 'Превью', 'Монтаж'] as const;

/** `current` — номер шага в STEP_NAMES; шаги до него пройдены. */
export function Steps({ current }: { current: number }) {
  return (
    <ol className="steps" aria-label="Шаги">
      {STEP_NAMES.map((name, i) => (
        <li key={name} className={i < current ? 'done' : i === current ? 'now' : undefined} aria-current={i === current ? 'step' : undefined}>
          <span className="steps-bar" />
          {name}
        </li>
      ))}
    </ol>
  );
}
