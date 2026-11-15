import React from 'react';
import { createRoot } from 'react-dom/client';
import 'highlight.js/styles/github-dark.css';
import './index.css';
import { initWallpaper } from './lib/wallpaper';
import { initStyle } from './lib/style';
import { watchMotionPause } from './lib/motionPause';
import ErrorBoundary from './components/ErrorBoundary';
import { isCoverWindow, renderFirstLaunch, renderPlatformWindow } from './platform/entry';

const root = createRoot(document.getElementById('root')!);
const params = new URLSearchParams(location.search);
// IDE windows load the page with ?ide=<project root>, without the chat app.
const ide = params.get('ide');
initStyle();
// Not on lock covers: they are what is on screen while the user is away, and they never take focus.
if (!isCoverWindow(params)) watchMotionPause();
if (renderPlatformWindow(root, params)) {
  // One of this platform's own windows (platform/entry.tsx); it rendered itself.
} else if ((window.vibe as { remoteOnly?: boolean } | undefined)?.remoteOnly) {
  // Remote-only app (electron/platform.cts REMOTE_ONLY): there is no local server to talk to.
  void import('./components/remote/RemoteApp').then(({ default: RemoteApp }) => root.render(<React.StrictMode><ErrorBoundary><RemoteApp /></ErrorBoundary></React.StrictMode>));
} else if (ide) {
  void import('./components/editor/IdeApp').then(({ default: IdeApp }) => root.render(<React.StrictMode><IdeApp root={ide} file={params.get('file')} /></React.StrictMode>));
} else {
  initWallpaper();
  const app = import('./App');
  const main = (enter: boolean) => app.then(({ default: App }) => (
    <ErrorBoundary>{enter ? <div className="app-wall h-full"><div className="app-enter h-full"><App /></div></div> : <App />}</ErrorBoundary>
  ));
  if (!renderFirstLaunch(root, params, main)) void main(false).then((el) => root.render(<React.StrictMode>{el}</React.StrictMode>));
}
