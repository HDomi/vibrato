// electron-builder afterPack hook: sign the bundle. Renaming the Electron binary and editing Info.plist break
// Electron's own signature, and Apple Silicon refuses to run unsigned code. There is no Developer ID.
//
// With the self-signed "Vibrato Self-Signed" certificate the designated requirement is `identifier and certificate
// leaf`, the same for every build, so macOS keeps the privacy permissions (Accessibility, Screen Recording, ...)
// across updates. An ad-hoc signature ("-") pins the requirement to the build's cdhash and every update loses them.
// The certificate comes from MAC_SIGN_P12 (base64 .p12, the release workflow's secret) or ~/.vibrato/signing/
// vibrato-sign.p12; without either the bundle is signed ad hoc as before.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IDENTITY = 'Vibrato Self-Signed';
// The .p12 is only a transport format here; the secret store and the 0600 file are what protect the key.
const P12_PASSWORD = 'vibrato';
const LOCAL_P12 = path.join(os.homedir(), '.vibrato', 'signing', 'vibrato-sign.p12');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // npm can drop the executable bit on node-pty's helper; without it every terminal fails to start.
  const prebuilds = path.join(app, 'Contents/Resources/app/node_modules/node-pty/prebuilds');
  for (const dir of fs.existsSync(prebuilds) ? fs.readdirSync(prebuilds) : []) {
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
  allowHttpInWebViews(path.join(app, 'Contents/Info.plist'));
  sign(app);
};

function sign(app) {
  const p12 = loadP12();
  if (process.env.VIBRATO_SIGN_REQUIRED === '1' && !p12) throw new Error('VIBRATO_SIGN_REQUIRED: no signing certificate (MAC_SIGN_P12)');
  if (!p12) {
    console.log('  • signing ad hoc (no Vibrato signing certificate)');
    codesign(app, ['--sign', '-']);
    return;
  }
  // A throwaway keychain: nothing touches the login keychain, and no access prompt appears.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibrato-sign-'));
  const keychain = path.join(dir, 'sign.keychain-db');
  const pass = crypto.randomBytes(16).toString('hex');
  const security = (...args) => execFileSync('/usr/bin/security', args, { stdio: 'pipe' });
  try {
    fs.writeFileSync(path.join(dir, 'id.p12'), p12, { mode: 0o600 });
    security('create-keychain', '-p', pass, keychain);
    security('set-keychain-settings', '-t', '3600', keychain);
    security('unlock-keychain', '-p', pass, keychain);
    security('import', path.join(dir, 'id.p12'), '-k', keychain, '-P', P12_PASSWORD, '-T', '/usr/bin/codesign');
    security('set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', pass, keychain);
    console.log(`  • signing with "${IDENTITY}"`);
    codesign(app, ['--keychain', keychain, '--sign', IDENTITY]);
  } finally {
    try { security('delete-keychain', keychain); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function loadP12() {
  const b64 = (process.env.MAC_SIGN_P12 || '').replace(/\s+/g, '');
  if (b64) return Buffer.from(b64, 'base64');
  return fs.existsSync(LOCAL_P12) ? fs.readFileSync(LOCAL_P12) : null;
}

function codesign(app, args) {
  execFileSync('codesign', ['--force', '--deep', ...args, app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
}

/**
 * The in-app browser (WKWebView) must open plain-http dev servers (http://localhost:3000, LAN IPs). electron-builder
 * always adds NSAllowsLocalNetworking plus NSExceptionDomains for localhost and 127.0.0.1 written with the old
 * NSTemporaryException* keys; current macOS reads those two entries as "secure connections only", so App Transport
 * Security blocked exactly the dev servers (checked 2026-11-09: removing NSExceptionDomains alone makes them load).
 * Leave arbitrary loads on, like the stock Electron.app. Electron's own network stack (Chromium) is not subject to ATS.
 */
function allowHttpInWebViews(plist) {
  const buddy = (cmd) => { try { execFileSync('/usr/libexec/PlistBuddy', ['-c', cmd, plist], { stdio: 'pipe' }); return true; } catch { return false; } };
  buddy('Delete :NSAppTransportSecurity:NSExceptionDomains');
  buddy('Delete :NSAppTransportSecurity:NSAllowsLocalNetworking');
  for (const key of ['NSAllowsArbitraryLoads', 'NSAllowsArbitraryLoadsInWebContent']) {
    if (!buddy(`Set :NSAppTransportSecurity:${key} true`)) buddy(`Add :NSAppTransportSecurity:${key} bool true`);
  }
}
