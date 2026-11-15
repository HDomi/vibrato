import { PermissionsError, type PermState, type PrivacySnapshot } from '../permissions.js';

/*
 * Windows has no per-app privacy decisions like macOS TCC for what this app does (files, automation), so the
 * operating system's part of Settings > Permissions is empty and nothing can be requested, reset or opened.
 */

export async function privacySnapshot(_opts: { bundlePath?: string } = {}): Promise<PrivacySnapshot> {
  return { bundleIds: [], fullDisk: true, tcc: null, tccDbs: [], folders: { desktop: 'granted', documents: 'granted', downloads: 'granted' }, photos: 'unknown' };
}

export async function requestPermission(id: string): Promise<PermState> {
  throw new PermissionsError(`Unknown permission "${id}"`);
}

export async function resetPermission(service: string, _bundlePath?: string): Promise<void> {
  throw new PermissionsError(`Unknown service "${service}"`);
}

export async function openSettingsPane(pane: string): Promise<void> {
  throw new PermissionsError(`Unknown settings pane "${pane}"`);
}
