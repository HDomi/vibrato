#!/usr/bin/env node
// Platform layout: the repository holds the code every target shares (base), and platforms/<target>/ holds the files
// only that target has, at the path they take in the build: platforms/mac/server/os/shell.ts is server/os/shell.ts of
// the macOS app, platforms/windows/server/os/shell.ts the same module of the Windows app.
//
// Nothing runs from the repository tree directly. Every command first assembles the target's tree (base, then the
// target's files on top) in a stage directory outside the repo, and builds, tests or serves from there. Build
// output is copied back to dist/ and web/dist/, where Electron and the packager expect it.
//
// Usage: node scripts/platform.cjs <command> [--target=mac|windows] [args]
//   Target: --target, else VIBRATO_TARGET, else the machine's own (windows on Windows, mac elsewhere).
//   build:main | build:web | build:native   compile to dist/, web/dist/, dist/native/
//   typecheck | test [node --test args] | test:ui
//   dev      Vite and the server from the stage, kept in step with edits in the repo
//   serve    the server from the stage
//   stage    assemble the tree and print its path
//   check    structure rules for every target (see checkTarget)
//   accept   record the base files a target shadows as reviewed
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const TARGETS = ['mac', 'windows'];
/** Never part of a stage: build output, dependencies, and the platform directories themselves. */
const BASE_SKIP = new Set(['.git', 'node_modules', 'dist', 'web/dist', 'release', 'runtime', 'platforms', '.claude']);
const SKIP_NAMES = new Set(['.DS_Store']);
const REVIEWED = '.base-hashes.json';
const MANIFEST = '.stage-files.json';

const argv = process.argv.slice(2);
const cmd = argv.shift();
const targetArg = argv.find((a) => a.startsWith('--target='));
const rest = argv.filter((a) => a !== targetArg);
const target = targetArg ? targetArg.slice('--target='.length) : process.env.VIBRATO_TARGET || (process.platform === 'win32' ? 'windows' : 'mac');
if (!TARGETS.includes(target)) fail(`unknown target "${target}" (expected ${TARGETS.join(', ')})`);

function fail(msg) { console.error(`platform: ${msg}`); process.exit(1); }
const posix = (p) => p.split(path.sep).join('/');
const platformDir = (t) => path.join(root, 'platforms', t);
const stageDir = (t) => path.join(os.tmpdir(), `vibrato-stage-${t}-${crypto.createHash('sha1').update(root).digest('hex').slice(0, 8)}`);

/** Files below `dir`, relative with forward slashes. `skip(rel)` prunes files and whole directories. */
function walk(dir, skip = () => false) {
  const out = [];
  const visit = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP_NAMES.has(e.name) || skip(r)) continue;
      if (e.isDirectory()) visit(path.join(abs, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  if (fs.existsSync(dir)) visit(dir, '');
  return out;
}

/** node-gyp output next to a native module's sources. */
const isNativeBuild = (rel) => /(^|\/)native\/[^/]+\/build$/.test(rel);
const baseFiles = () => walk(root, (rel) => BASE_SKIP.has(rel) || isNativeBuild(rel));
const platformFiles = (t) => walk(platformDir(t), (rel) => rel === REVIEWED || isNativeBuild(rel));

/** Where each file of the target's tree comes from: the target's own copy wins over the base one. */
function sources(t) {
  const map = new Map();
  for (const rel of baseFiles()) map.set(rel, path.join(root, rel));
  for (const rel of platformFiles(t)) map.set(rel, path.join(platformDir(t), rel));
  return map;
}

function copyIfChanged(from, to) {
  const a = fs.statSync(from);
  const b = fs.statSync(to, { throwIfNoEntry: false });
  if (b && b.size === a.size && Math.abs(b.mtimeMs - a.mtimeMs) < 2) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  fs.utimesSync(to, a.atime, a.mtime);
}

/** Bring the stage in step with the repo: copy what changed, drop what an earlier run staged and is gone now. */
function sync(t = target) {
  const stage = stageDir(t);
  const map = sources(t);
  let before = null;
  try { before = JSON.parse(fs.readFileSync(path.join(stage, MANIFEST), 'utf8')); } catch { /* first run */ }
  // Without its list of staged files a leftover directory cannot be trusted (an older layout may sit in it).
  if (!Array.isArray(before)) { fs.rmSync(stage, { recursive: true, force: true }); before = []; }
  fs.mkdirSync(stage, { recursive: true });
  for (const rel of before) if (!map.has(rel)) fs.rmSync(path.join(stage, rel), { force: true });
  for (const [rel, from] of map) copyIfChanged(from, path.join(stage, rel));
  fs.writeFileSync(path.join(stage, MANIFEST), JSON.stringify([...map.keys()]));
  const modules = path.join(stage, 'node_modules');
  // A junction needs no admin rights on Windows; elsewhere it is a plain symlink.
  if (!fs.lstatSync(modules, { throwIfNoEntry: false })) fs.symlinkSync(path.join(root, 'node_modules'), modules, 'junction');
  return stage;
}

/** The CLIs' own entry scripts (what node_modules/.bin links to), run with this Node: no shell, same on Windows. */
const CLI = { tsc: 'typescript/bin/tsc', vite: 'vite/bin/vite.js', tsx: 'tsx/dist/cli.mjs' };
const cli = (name) => path.join(root, 'node_modules', CLI[name]);
function run(name, args, cwd, env = process.env) {
  try { execFileSync(process.execPath, [cli(name), ...args], { cwd, stdio: 'inherit', env }); }
  catch (err) { process.exit(typeof err.status === 'number' ? err.status : 1); }
}

/** Make `to` hold exactly the files of `from`: copy all, then drop what `from` no longer has. */
function mirror(from, to) {
  const want = new Set(walk(from));
  for (const rel of want) {
    fs.mkdirSync(path.dirname(path.join(to, rel)), { recursive: true });
    fs.copyFileSync(path.join(from, rel), path.join(to, rel));
  }
  for (const rel of walk(to)) if (!want.has(rel)) fs.rmSync(path.join(to, rel), { force: true });
}

/** Names a TypeScript/JavaScript module exports (declarations and `export { a, b }` lists). */
function exportedNames(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) { const name = part.trim().split(/\s+as\s+/).pop(); if (name) names.add(name.replace(/^type\s+/, '')); }
  }
  return names;
}

/** Line endings are normalized so a Windows checkout (autocrlf) hashes the same as a Mac one. */
function hashFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex'); }
function readReviewed(t) { try { return JSON.parse(fs.readFileSync(path.join(platformDir(t), REVIEWED), 'utf8')); } catch { return {}; } }
/** The base files a target replaces with its own copy, with their current hashes. */
function shadowed(t) {
  const out = {};
  for (const rel of platformFiles(t)) if (fs.existsSync(path.join(root, rel))) out[rel] = hashFile(path.join(root, rel));
  return out;
}

const isModule = (rel) => /\.(c|m)?(tsx?|js)$/.test(rel);

/**
 * Rules that keep the targets from drifting apart:
 * - A target should add files, not replace base ones. Where it does replace one, the base file's hash is recorded
 *   (accept), so a later change to the base file fails here until the replacement was looked at again, and the
 *   replacement must export every name the base file exports.
 * - A module the targets provide at the same path (server/os/*, electron/platform.cts, web/src/platform/*) is a
 *   contract with the shared code; each target's type check is what holds it (typecheck, typecheck:win).
 */
function checkTarget(t) {
  const problems = [];
  const reviewed = readReviewed(t);
  for (const [rel, hash] of Object.entries(shadowed(t))) {
    if (reviewed[rel] !== hash) problems.push(`${rel}: ${rel in reviewed ? 'the base file changed' : 'replaces a base file'}; compare it with platforms/${t}/${rel}, then run "node scripts/platform.cjs accept --target=${t}"`);
    if (isModule(rel)) {
      const mine = exportedNames(path.join(platformDir(t), rel));
      const lost = [...exportedNames(path.join(root, rel))].filter((n) => !mine.has(n));
      if (lost.length) problems.push(`${rel}: does not export ${lost.join(', ')} like the base file`);
    }
  }
  return problems;
}

/** Repo edits reach the stage while `dev` runs (Vite and tsx watch the stage). */
function watch(stage) {
  let timer = null;
  const again = () => { clearTimeout(timer); timer = setTimeout(() => { try { sync(); } catch (err) { console.error(`platform: sync failed: ${err.message}`); } }, 80); };
  const ignored = (rel) => !rel || /^(\.git|node_modules|dist|web\/dist|release)(\/|$)/.test(rel);
  fs.watch(root, { recursive: true }, (_event, file) => { if (file && !ignored(posix(String(file)))) again(); });
  console.log(`platform: ${target} dev tree in ${stage} (follows edits in the repo)`);
}

function children(list) {
  const procs = list.map(([name, args, env]) => spawn(process.execPath, [cli(name), ...args], { cwd: stageDir(target), stdio: 'inherit', env: { ...process.env, ...env } }));
  const stop = () => { for (const p of procs) p.kill(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  for (const p of procs) p.on('exit', (code) => { stop(); process.exit(code || 0); });
}

/** The staged server answers as the repository it was staged from (updates, build info, web/dist). */
const serverEnv = (extra = {}) => ({ VIBRATO_REPO_ROOT: root, ...extra });

function node(script, cwd, env = process.env, exe = process.execPath) {
  try { execFileSync(exe, [script], { cwd, stdio: 'inherit', env }); }
  catch (err) { process.exit(typeof err.status === 'number' ? err.status : 1); }
}

switch (cmd) {
  case 'stage': console.log(sync()); break;
  case 'build:main': {
    const stage = sync();
    const out = path.join(stage, 'dist');
    for (const d of ['electron', 'server', 'web']) fs.rmSync(path.join(out, d), { recursive: true, force: true });
    run('tsc', ['-p', 'tsconfig.json'], stage);
    fs.copyFileSync(path.join(stage, 'electron', 'preload.cjs'), path.join(out, 'electron', 'preload.cjs'));
    for (const d of ['electron', 'server', 'web']) mirror(path.join(out, d), path.join(root, 'dist', d));
    break;
  }
  case 'build:web': {
    const stage = sync();
    run('vite', ['build'], stage);
    mirror(path.join(stage, 'web', 'dist'), path.join(root, 'web', 'dist'));
    break;
  }
  case 'build:native': {
    const stage = sync();
    const out = path.join(root, 'dist', 'native');
    fs.rmSync(path.join(stage, 'dist', 'native'), { recursive: true, force: true });
    if (!fs.existsSync(path.join(stage, 'native'))) { fs.rmSync(out, { recursive: true, force: true }); console.log(`build-native: ${target} has no native modules`); break; }
    node(path.join(stage, 'scripts', 'build-native.cjs'), stage);
    if (fs.existsSync(path.join(stage, 'dist', 'native'))) mirror(path.join(stage, 'dist', 'native'), out);
    break;
  }
  case 'typecheck': {
    const stage = sync();
    run('tsc', ['-p', 'tsconfig.json', '--noEmit'], stage);
    run('tsc', ['-p', path.join('web', 'tsconfig.json'), '--noEmit'], stage);
    break;
  }
  case 'test': {
    const stage = sync();
    const tests = fs.readdirSync(path.join(stage, 'tests')).filter((f) => /\.test\.tsx?$/.test(f)).sort().map((f) => path.join('tests', f));
    // Fixed locale: a few tests compare formatted dates and sorted names.
    run('tsx', ['--tsconfig', path.join('web', 'tsconfig.json'), '--test', ...rest, ...tests], stage, { ...process.env, LC_ALL: 'en_US.UTF-8' });
    break;
  }
  case 'test:ui': {
    const stage = sync();
    // The harness page uses the built stylesheet.
    run('vite', ['build', '--logLevel', 'warn'], stage);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    node(path.join('tests', 'smoke-ui.cjs'), stage, env, require(path.join(root, 'node_modules', 'electron')));
    break;
  }
  case 'dev': {
    watch(sync());
    children([['vite', [], {}], ['tsx', ['watch', path.join('server', 'index.ts')], serverEnv({ VIBRATO_DEV: '1' })]]);
    break;
  }
  case 'serve': {
    sync();
    children([['tsx', [path.join('server', 'index.ts')], serverEnv()]]);
    break;
  }
  case 'check': {
    let bad = false;
    for (const t of TARGETS) {
      const problems = checkTarget(t);
      if (problems.length) { bad = true; console.error(`platform: ${t}:\n  ${problems.join('\n  ')}`); }
      else console.log(`platform: ${t}: ${platformFiles(t).length} file(s), structure ok`);
    }
    if (bad) process.exit(1);
    break;
  }
  case 'accept': {
    const now = shadowed(target);
    const file = path.join(platformDir(target), REVIEWED);
    if (Object.keys(now).length) fs.writeFileSync(file, JSON.stringify(now, null, 2) + '\n'); else fs.rmSync(file, { force: true });
    console.log(`platform: ${target}: recorded ${Object.keys(now).length} replaced base file(s) as reviewed`);
    break;
  }
  default: fail('usage: platform.cjs <build:main|build:web|build:native|typecheck|test|test:ui|dev|serve|stage|check|accept> [--target=mac|windows]');
}
