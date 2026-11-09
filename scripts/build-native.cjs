#!/usr/bin/env node
// Builds the native modules (native/*) with node-gyp and copies them to dist/native.
// They use N-API only, so one build loads in any Electron. A machine without Xcode's command line tools
// still gets a working app (the in-app browser reports itself unavailable) unless VIBRATO_NATIVE_REQUIRED=1,
// which release builds set so a broken module never ships.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist', 'native');
const required = process.env.VIBRATO_NATIVE_REQUIRED === '1';
const modules = [{ dir: 'native/webview', target: 'vibrato_webview' }];

if (process.platform !== 'darwin') { console.log('build-native: skipped (macOS only)'); process.exit(0); }
fs.mkdirSync(out, { recursive: true });
let failed = false;
for (const m of modules) {
  const cwd = path.join(root, m.dir);
  try {
    execFileSync(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', '--silent'], { cwd, stdio: 'inherit' });
    fs.copyFileSync(path.join(cwd, 'build', 'Release', `${m.target}.node`), path.join(out, `${m.target}.node`));
    console.log(`build-native: ${m.target}.node`);
  } catch (err) {
    failed = true;
    console.warn(`build-native: ${m.target} failed: ${err.message}`);
  }
}
if (failed && required) process.exit(1);
