import React from 'react';
import { createRoot } from 'react-dom/client';
import 'highlight.js/styles/github-dark.css';
import './index.css';
import { initWallpaper } from './lib/wallpaper';
import { finishIntro, needsIntro } from './lib/intro';
import ErrorBoundary from './components/ErrorBoundary';

const root = createRoot(document.getElementById('root')!);
const params = new URLSearchParams(location.search);
// Lock screen covers load this page with ?lock=main|sub. They must not import the app: its modules open
// the agent socket on import, and a cover only needs the clock, the session counts and the password field.
const lock = params.get('lock');
// IDE windows load it with ?ide=<project root>; likewise without the chat app.
const ide = params.get('ide');
if (lock === 'main' || lock === 'sub') {
  initWallpaper();
  void import('./components/lock/LockScreen').then(({ default: LockScreen }) => root.render(<LockScreen />));
} else if (ide) {
  void import('./components/editor/IdeApp').then(({ default: IdeApp }) => root.render(<React.StrictMode><IdeApp root={ide} file={params.get('file')} /></React.StrictMode>));
} else {
  initWallpaper();
  const app = import('./App');
  const main = (enter: boolean) => app.then(({ default: App }) => (
    <ErrorBoundary>{enter ? <div className="app-wall h-full"><div className="app-enter h-full"><App /></div></div> : <App />}</ErrorBoundary>
  ));
  if (needsIntro(localStorage, params.get('intro') === '1')) {
    // First launch: the intro asks for the folder permissions, then fades out and the app fades in on the same wallpaper.
    void import('./components/intro/Intro').then(({ default: Intro }) => root.render(
      <React.StrictMode>
        <div className="app-wall h-full">
          <Intro onDone={() => { finishIntro(localStorage); void main(true).then((el) => root.render(<React.StrictMode>{el}</React.StrictMode>)); }} />
        </div>
      </React.StrictMode>,
    ));
  } else {
    void main(false).then((el) => root.render(<React.StrictMode>{el}</React.StrictMode>));
  }
}
