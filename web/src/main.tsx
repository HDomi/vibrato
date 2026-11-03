import React from 'react';
import { createRoot } from 'react-dom/client';
import 'highlight.js/styles/github-dark.css';
import './index.css';
import { initWallpaper } from './lib/wallpaper';

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
  void import('./App').then(({ default: App }) => root.render(<React.StrictMode><App /></React.StrictMode>));
}
