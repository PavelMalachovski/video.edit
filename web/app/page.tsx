import JobsList from './jobs-list';
import { Steps } from './steps';
import Uploader from './uploader';

export default function Home() {
  return (
    <main>
      <header className="top">
        <h1 className="logo">video<b>.</b>edit</h1>
        <span className="muted small">для одного</span>
      </header>
      <Uploader />
      <Steps current={0} />
      <JobsList />
    </main>
  );
}
