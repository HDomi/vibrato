const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Tracked from preload time: the main process reports full screen on load, possibly before React subscribes.
let fullScreen = false;
ipcRenderer.on('full-screen', (_e, on) => { fullScreen = !!on; });

contextBridge.exposeInMainWorld('vibe', {
  isElectron: true,
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openIde: (root, file) => ipcRenderer.invoke('open-ide', root, file),
  // In-app browser window (electron/browser.cts); `url` opens in a new tab.
  openBrowser: (url) => ipcRenderer.invoke('open-browser', url),
  // The browser window's own UI: tabs, the page area it reserves for the native web view, and the logs.
  browser: {
    info: () => ipcRenderer.invoke('browser:info'),
    frame: (rect) => ipcRenderer.send('browser:frame', rect),
    open: (url) => ipcRenderer.invoke('browser:open', url),
    activate: (id) => ipcRenderer.send('browser:activate', id),
    close: (id) => ipcRenderer.send('browser:close', id),
    navigate: (url) => ipcRenderer.send('browser:navigate', url),
    nav: (action) => ipcRenderer.send('browser:nav', action),
    zoom: (factor) => ipcRenderer.send('browser:zoom', factor),
    clear: (kind) => ipcRenderer.send('browser:clear', kind),
    storage: (op) => ipcRenderer.invoke('browser:storage', op),
    device: (d) => ipcRenderer.send('browser:device', d),
    pause: (on) => ipcRenderer.send('browser:pause', on),
    pick: (on) => ipcRenderer.send('browser:pick', on),
    refs: (on) => ipcRenderer.send('browser:refs', on),
    netDetail: (seq) => ipcRenderer.invoke('browser:net-detail', seq),
    mockRemove: (id) => ipcRenderer.invoke('browser:mock-remove', id),
    export: (format) => ipcRenderer.invoke('browser:export', format),
    on: (channel, cb) => {
      if (!['tabs', 'console', 'net', 'agent', 'storage-changed', 'flags', 'picked'].includes(channel)) return () => {};
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on(`browser:${channel}`, h);
      return () => ipcRenderer.removeListener(`browser:${channel}`, h);
    },
  },
  onIdeOpenFile: (cb) => { const h = (_e, file) => cb(file); ipcRenderer.on('ide-open-file', h); return () => ipcRenderer.removeListener('ide-open-file', h); },
  // Native Save As sheet: { defaultPath, ext, label } -> chosen path or null.
  saveDialog: (opts) => ipcRenderer.invoke('save-dialog', opts),
  // Absolute path of a File dropped from Finder (browser mode cannot read this).
  getPathForFile: (file) => webUtils.getPathForFile(file),
  // Read or set "open at login". Pass null to only read.
  loginItem: (enable) => ipcRenderer.invoke('login-item', enable),
  // UI language sync with the macOS menu bar.
  setLanguage: (lang) => ipcRenderer.send('language', lang),
  onLanguage: (cb) => { ipcRenderer.on('language', (_e, lang) => cb(lang)); },
  // Native macOS notification; a click brings the window back and reports the session id.
  notify: (payload) => ipcRenderer.send('notify', payload),
  onNotificationClick: (cb) => { ipcRenderer.on('notify-click', (_e, sessionId) => cb(sessionId)); },
  // Approval answered from a notification button; closing drops a notification whose request was settled in the app.
  onNotificationApproval: (cb) => { ipcRenderer.on('notify-approval', (_e, answer) => cb(answer)); },
  closeNotification: (requestId) => ipcRenderer.send('notify-close', requestId),
  // System Settings > Notifications > Vibrato, for switching banners to alerts that stay on screen.
  openNotificationSettings: () => ipcRenderer.send('open-notification-settings'),
  // Settings > Permissions: app-process privacy states and the prompts only the app can raise.
  permissions: {
    info: () => ipcRenderer.invoke('permissions:info'),
    ask: (id) => ipcRenderer.invoke('permissions:ask', id),
  },
  // Hold / release the "no idle sleep" assertion while agents or shells are busy; wake-up signal for reconnects.
  keepAwake: (busy) => ipcRenderer.send('keep-awake', busy),
  onPowerResume: (cb) => { ipcRenderer.on('power-resume', () => cb()); },
  // Full screen hides the traffic lights, so the title bar drops the space it keeps for them.
  onFullScreen: (cb) => { cb(fullScreen); const h = (_e, on) => cb(on); ipcRenderer.on('full-screen', h); return () => ipcRenderer.removeListener('full-screen', h); },
  // Lock screen (see electron/lockScreen.cts). App window: settings, password, session counts, lock now.
  // Cover windows: init / unlock / live updates.
  lock: {
    get: () => ipcRenderer.invoke('lock:get'),
    set: (patch) => ipcRenderer.invoke('lock:set', patch),
    setPassword: (req) => ipcRenderer.invoke('lock:password', req),
    newRecoveryCode: (current) => ipcRenderer.invoke('lock:recovery', current),
    now: () => ipcRenderer.send('lock:now'),
    reportSessions: (list) => ipcRenderer.send('lock:sessions', list),
    onOpenSettings: (cb) => { const h = () => cb(); ipcRenderer.on('lock:open-settings', h); return () => ipcRenderer.removeListener('lock:open-settings', h); },
    onDisplays: (cb) => { const h = () => cb(); ipcRenderer.on('lock:displays', h); return () => ipcRenderer.removeListener('lock:displays', h); },
    init: () => ipcRenderer.invoke('lock:init'),
    unlock: (password) => ipcRenderer.invoke('lock:unlock', password),
    // Main cover's liveness ping for the watchdog in lockScreen.cts.
    alive: () => ipcRenderer.send('lock:alive'),
    onUpdate: (cb) => { const h = (_e, u) => cb(u); ipcRenderer.on('lock:update', h); return () => ipcRenderer.removeListener('lock:update', h); },
  },
});
