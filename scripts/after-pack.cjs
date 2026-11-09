// electron-builder afterPack hook: ad-hoc sign the bundle. Renaming the Electron binary and editing
// Info.plist break Electron's own signature, and Apple Silicon refuses to run unsigned code.
// There is no Developer ID, so the signature is ad hoc ("-"), the same as install.sh produces.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};

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
