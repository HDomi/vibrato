export {};

export interface ViewBounds { x: number; y: number; width: number; height: number }
export interface LockSettings { mainDisplay: string | null; mainBg: string; subBg: string; heartbeat: boolean }
export interface LockDisplay { key: string; label: string; internal: boolean; primary: boolean; main: boolean; bounds: ViewBounds }
export interface LockSessionSummary { agent: string; total: number; running: number; waiting: number }
export interface LockInit { role: 'main' | 'sub'; self: ViewBounds; displays: LockDisplay[]; settings: LockSettings; sessions: LockSessionSummary[]; retryIn: number }
export interface LockBridge {
  get: () => Promise<{ settings: LockSettings; hasPassword: boolean; hasRecovery: boolean; displays: LockDisplay[] } | null>;
  set: (patch: Partial<LockSettings>) => Promise<LockSettings | null>;
  setPassword: (req: { current?: string; next: string }) => Promise<{ ok: boolean; error?: 'invalid' | 'short' | 'wrong' | 'wait'; retryIn?: number; hasPassword?: boolean; hasRecovery?: boolean; recoveryCode?: string }>;
  /** Replace the recovery code; needs the current password. The code is returned once. */
  newRecoveryCode: (current: string) => Promise<{ ok: boolean; error?: 'invalid' | 'wrong' | 'wait'; retryIn?: number; recoveryCode?: string }>;
  now: () => void;
  reportSessions: (list: LockSessionSummary[]) => void;
  onOpenSettings: (cb: () => void) => () => void;
  onDisplays: (cb: () => void) => () => void;
  init: () => Promise<LockInit | null>;
  unlock: (password: string) => Promise<{ ok: boolean; retryIn?: number }>;
  alive: () => void;
  onUpdate: (cb: (u: { sessions?: LockSessionSummary[]; settings?: LockSettings }) => void) => () => void;
}

declare global {
  interface Window {
    vibe?: {
      isElectron: boolean;
      pickFolder: () => Promise<string | null>;
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
      keepAwake?: (busy: boolean) => void;
      onPowerResume?: (cb: () => void) => void;
      onFullScreen?: (cb: (on: boolean) => void) => () => void;
      /** Lock screen bridge (Electron only). */
      lock?: LockBridge;
    };
  }
}
