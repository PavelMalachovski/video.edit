import ScriptForm from './script-form';

export const metadata = { title: 'Новый сценарий · video.edit' };

export default function ScriptPage() {
  return (
    <main>
      <a className="back muted" href="/">← Мои видео</a>
      <div className="job-head">
        <h1>Новый сценарий</h1>
        <p className="lead muted">Claude напишет сценарий до съёмки по гайду Meta: три хука, раскадровку, призыв, советы и подпись к посту.</p>
      </div>
      <ScriptForm />
    </main>
  );
}
