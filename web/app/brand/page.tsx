import { TopBar } from '../top-bar';
import BrandForm from './brand-form';

export const metadata = { title: 'Мой бренд · video.edit' };

export default function BrandPage() {
  return (
    <main>
      <TopBar back={{ href: '/', label: 'Мои видео' }} title="Мой бренд" />
      <p className="lead">Ник, цвета, шрифты и логотип — для новых роликов: стиль A, финальная карточка и подпись к посту.</p>
      <BrandForm />
    </main>
  );
}
