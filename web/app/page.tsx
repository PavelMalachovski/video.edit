import { PlayIcon } from './icons';
import JobsList from './jobs-list';
import { Steps } from './steps';
import Uploader from './uploader';

export default function Home() {
  return (
    <main>
      <header className="top">
        <h1 className="logo"><span className="logo-mark"><PlayIcon size={16} /></span>video.edit</h1>
        <nav className="top-links">
          <a className="top-link" href="/script">Сценарий</a>
          <a className="top-link" href="/brand">Мой бренд</a>
        </nav>
      </header>
      <Uploader />
      <Steps current={0} />
      <JobsList />
    </main>
  );
}
