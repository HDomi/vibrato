import type React from 'react';
import type { Root } from 'react-dom/client';

/** No lock screen covers on this platform. */
export function isCoverWindow(_params: URLSearchParams): boolean {
  return false;
}

/** No windows of its own beside the app and the IDE. */
export function renderPlatformWindow(_root: Root, _params: URLSearchParams): boolean {
  return false;
}

/** No first-launch intro: there are no permissions to ask for up front. */
export function renderFirstLaunch(_root: Root, _params: URLSearchParams, _main: (enter: boolean) => Promise<React.ReactElement>): boolean {
  return false;
}
