import BrandForm from './brand-form';

export const metadata = { title: 'Мой бренд · video.edit' };

export default function BrandPage() {
  return (
    <main>
      <a className="back muted" href="/">← Мои видео</a>
      <div className="job-head">
        <h1>Мой бренд</h1>
        <p className="lead muted">Ник, цвета, шрифты и логотип — для новых роликов: стиль A, финальная карточка и подпись к посту.</p>
      </div>
      <BrandForm />
    </main>
  );
}
