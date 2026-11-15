import React from 'react';
import type { Root } from 'react-dom/client';
import { initWallpaper } from '../lib/wallpaper';
import { finishIntro, needsIntro } from '../lib/intro';

/**
 * Lock screen covers load this page with ?lock=main|sub. They must not import the app: its modules open
 * the agent socket on import, and a cover only needs the clock, the session counts and the password field.
 */
export function isCoverWindow(params: URLSearchParams): boolean {
  const lock = params.get('lock');
  return lock === 'main' || lock === 'sub';
}

/** Windows that load the page without the chat app: lock covers and the in-app browser. True when one was rendered. */
export function renderPlatformWindow(root: Root, params: URLSearchParams): boolean {
  if (isCoverWindow(params)) {
    initWallpaper();
    void import('../components/lock/LockScreen').then(({ default: LockScreen }) => root.render(<LockScreen />));
    return true;
  }
  if (params.get('browser') === '1') {
    // The in-app browser window (electron/browser.cts); no chat app either.
    initWallpaper();
    void import('../components/browser/BrowserApp').then(({ default: BrowserApp }) => root.render(<React.StrictMode><BrowserApp /></React.StrictMode>));
    return true;
  }
  return false;
}

/**
 * First launch: the intro asks for the folder permissions, then fades out and the app fades in on the same wallpaper.
 * False when there is no intro to show (the caller renders the app right away).
 */
export function renderFirstLaunch(root: Root, params: URLSearchParams, main: (enter: boolean) => Promise<React.ReactElement>): boolean {
  if (!needsIntro(localStorage, params.get('intro') === '1')) return false;
  void import('../components/intro/Intro').then(({ default: Intro }) => root.render(
    <React.StrictMode>
      <div className="app-wall h-full">
        <Intro onDone={() => { finishIntro(localStorage); void main(true).then((el) => root.render(<React.StrictMode>{el}</React.StrictMode>)); }} />
      </div>
    </React.StrictMode>,
  ));
  return true;
}
