import { TopBar } from '../top-bar';
import ScriptForm from './script-form';

export const metadata = { title: 'Новый сценарий · video.edit' };

export default function ScriptPage() {
  return (
    <main>
      <TopBar back={{ href: '/', label: 'Мои видео' }} title="Новый сценарий" />
      <p className="lead">Claude напишет сценарий до съёмки по гайду Meta: три хука, раскадровку, призыв, советы и подпись к посту.</p>
      <ScriptForm />
    </main>
  );
}
