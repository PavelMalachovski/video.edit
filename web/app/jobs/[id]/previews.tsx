'use client';
// Экран «3 · Три превью» (задача 11 рисует превью шаблоном и запускает монтаж).
export default function Previews({ onBack }: { onBack: () => void }) {
  return (
    <>
      <button type="button" className="back link" onClick={onBack}>← Вопросы</button>
      <h2 className="screen-title">Выбери стиль</h2>
    </>
  );
}
