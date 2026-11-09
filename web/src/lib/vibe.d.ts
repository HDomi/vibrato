export {};

export interface ViewBounds { x: number; y: number; width: number; height: number }
export interface LockSettings { mainDisplay: string | null }
export interface LockDisplay { key: string; label: string; internal: boolean; primary: boolean; main: boolean; bounds: ViewBounds }
export interface LockSessionSummary { agent: string; total: number; running: number; waiting: number }
export interface LockInit { role: 'main' | 'sub'; sessions: LockSessionSummary[]; retryIn: number }
/** Privacy states only the app process can read (electron/main.cts `permissions:info`). */
export interface AppPermissionInfo {
  bundlePath: string | null;
  screen: string; camera: string; microphone: string;
  accessibility: boolean;
  loginItem: boolean;
}
/** In-app browser (electron/browser.cts). */
export interface BrowserTab { id: number; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; progress: number; opener?: number; agent?: boolean; zoom: number }
export interface BrowserConsoleEntry { seq: number; t: number; tab: number; level: string; text: string; source?: string }
export interface BrowserNetEntry { seq: number; t: number; tab: number; via: string; method: string; url: string; status?: number; type?: string; size?: number; ms?: number; error?: string }
export interface BrowserAgentEntry { seq: number; t: number; tool: string; summary: string; ok: boolean; ms: number; result?: string; image?: string }
export type BrowserStorageArea = 'local' | 'session' | 'cookies';
export interface BrowserCookie { name: string; value: string; domain: string; path: string; expires?: number; httpOnly: boolean; secure: boolean; session: boolean; sameSite?: string }
export interface BrowserStorageResult { origin: string; items?: [string, string][]; cookies?: BrowserCookie[]; changed?: number }
export interface BrowserBridge {
  info: () => Promise<{ available: boolean; error: string; tabs: BrowserTab[]; active: number | null; console: BrowserConsoleEntry[]; net: BrowserNetEntry[]; agent: BrowserAgentEntry[] } | null>;
  /** Where the page goes, in window coordinates; null hides it. */
  frame: (rect: { x: number; y: number; w: number; h: number } | null) => void;
  open: (url: string) => Promise<number>;
  activate: (id: number) => void;
  close: (id: number) => void;
  navigate: (url: string) => void;
  nav: (action: 'back' | 'forward' | 'reload' | 'stop' | 'focus') => void;
  zoom: (factor: number) => void;
  clear: (kind: 'console' | 'net' | 'agent') => void;
  /** Active tab's storage: list, set, remove or clear. Null when no tab is open. */
  storage: (op: { action: 'get' | 'set' | 'remove' | 'clear'; area: BrowserStorageArea; key?: string; value?: string; cookie?: Partial<BrowserCookie> }) => Promise<BrowserStorageResult | null>;
  on(channel: 'tabs', cb: (p: { tabs: BrowserTab[]; active: number | null }) => void): () => void;
  on(channel: 'console', cb: (e: BrowserConsoleEntry) => void): () => void;
  on(channel: 'net', cb: (e: BrowserNetEntry) => void): () => void;
  on(channel: 'agent', cb: (e: BrowserAgentEntry) => void): () => void;
  /** An agent changed storage of this tab. */
  on(channel: 'storage-changed', cb: (e: { tab: number }) => void): () => void;
}
export interface LockBridge {
  get: () => Promise<{ settings: LockSettings; hasPassword: boolean; hasPin: boolean; hasRecovery: boolean; displays: LockDisplay[] } | null>;
  set: (patch: Partial<LockSettings>) => Promise<LockSettings | null>;
  setPassword: (req: { current?: string; next: string }) => Promise<{ ok: boolean; error?: 'invalid' | 'pin' | 'wrong' | 'wait'; retryIn?: number; hasPassword?: boolean; hasPin?: boolean; hasRecovery?: boolean; recoveryCode?: string }>;
  /** Replace the recovery code; needs the current password. The code is returned once. */
  newRecoveryCode: (current: string) => Promise<{ ok: boolean; error?: 'invalid' | 'wrong' | 'wait'; retryIn?: number; recoveryCode?: string }>;
  now: () => void;
  reportSessions: (list: LockSessionSummary[]) => void;
  onOpenSettings: (cb: () => void) => () => void;
  onDisplays: (cb: () => void) => () => void;
  init: () => Promise<LockInit | null>;
  unlock: (password: string) => Promise<{ ok: boolean; retryIn?: number }>;
  alive: () => void;
  onUpdate: (cb: (u: { sessions?: LockSessionSummary[] }) => void) => () => void;
}

declare global {
  interface Window {
    vibe?: {
      isElectron: boolean;
      pickFolder: () => Promise<string | null>;
      /** Opens (or focuses) the IDE window for `root`, optionally opening `file` in it. */
      openIde?: (root: string, file?: string) => Promise<void>;
      /** Opens the in-app browser window; `url` (http/https) opens in a new tab. */
      openBrowser?: (url?: string) => Promise<void>;
      /** The browser window's own bridge (only meaningful in `/?browser=1`). */
      browser?: BrowserBridge;
      /** IDE window: a file the main window asked to open. */
      onIdeOpenFile?: (cb: (file: string) => void) => () => void;
      saveDialog?: (opts: { defaultPath?: string; ext?: string; label?: string }) => Promise<string | null>;
      getPathForFile: (file: File) => string;
      loginItem: (enable: boolean | null) => Promise<boolean>;
      /** Tell the main process the current UI language (updates the Language menu checkmark). */
      setLanguage: (lang: string) => void;
      /** Receive language changes made from the macOS menu bar. */
      onLanguage: (cb: (lang: string) => void) => void;
      /**
       * Show a native notification; the click handler receives the session id passed here.
       * Approval notifications and ones carrying a `requestId` stay until closed; others fade after a few seconds.
       */
      notify: (payload: { title: string; body: string; sessionId: string; approval?: { requestId: string; canAlwaysAllow: boolean; labels: [string, string, string] }; requestId?: string }) => void;
      onNotificationClick: (cb: (sessionId: string) => void) => void;
      /** Allow / always allow / deny chosen on an approval notification's buttons. */
      onNotificationApproval?: (cb: (answer: { sessionId: string; requestId: string; decision: 'allow' | 'allow_always' | 'deny' }) => void) => void;
      closeNotification?: (requestId: string) => void;
      openNotificationSettings?: () => void;
      /** Settings > Permissions (Electron, macOS). `info` is null elsewhere. */
      permissions?: {
        info: () => Promise<AppPermissionInfo | null>;
        ask: (id: 'accessibility' | 'camera' | 'microphone') => Promise<boolean>;
      };
      keepAwake?: (busy: boolean) => void;
      onPowerResume?: (cb: () => void) => void;
      onFullScreen?: (cb: (on: boolean) => void) => () => void;
      /** Lock screen bridge (Electron only). */
      lock?: LockBridge;
    };
  }
}
