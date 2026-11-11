import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from '../config.js';

/**
 * The remote host's TLS identity: a self-signed P-256 certificate made once with the system openssl and kept in
 * ~/.vibrato/remote (owner-only). Clients pin its SHA-256 fingerprint, so it must stay the same across restarts;
 * deleting the folder makes a new one and every client has to trust it again.
 */
export const REMOTE_DIR = path.join(CONFIG_DIR, 'remote');
const KEY = path.join(REMOTE_DIR, 'host-key.pem');
const CERT = path.join(REMOTE_DIR, 'host-cert.pem');

export interface Identity { key: string; cert: string; fingerprint: string }

let pending: Promise<Identity> | null = null;

export function loadIdentity(): Promise<Identity> {
  pending ??= ensure().finally(() => { pending = null; });
  return pending;
}

async function ensure(): Promise<Identity> {
  try {
    const [key, cert] = await Promise.all([fs.readFile(KEY, 'utf8'), fs.readFile(CERT, 'utf8')]);
    // A certificate with explicit curve parameters cannot be read by Electron's BoringSSL: make a new one.
    if (namedCurve(cert)) return { key, cert, fingerprint: fingerprintOf(cert) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await fs.mkdir(REMOTE_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(REMOTE_DIR, 0o700);
  const tmp = await fs.mkdtemp(path.join(REMOTE_DIR, 'new-'));
  try {
    const k = path.join(tmp, 'key.pem');
    const c = path.join(tmp, 'cert.pem');
    await new Promise<void>((resolve, reject) => execFile('/usr/bin/openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      // LibreSSL writes explicit curve parameters unless told otherwise; BoringSSL (Electron) rejects those.
      '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-sha256', '-days', '36500',
      '-subj', '/CN=Vibrato Remote', '-keyout', k, '-out', c,
    ], { timeout: 20000 }, (err, _out, stderr) => (err ? reject(new Error(`openssl failed: ${String(stderr).trim() || err.message}`)) : resolve())));
    await fs.chmod(k, 0o600);
    await fs.chmod(c, 0o600);
    // Rename into place: a half-written pair is never picked up.
    await fs.rename(k, KEY);
    await fs.rename(c, CERT);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  const [key, cert] = await Promise.all([fs.readFile(KEY, 'utf8'), fs.readFile(CERT, 'utf8')]);
  return { key, cert, fingerprint: fingerprintOf(cert) };
}

/** id-ecPublicKey followed directly by the prime256v1 OID: the key names its curve. */
const NAMED_P256 = Buffer.from('06072a8648ce3d020106082a8648ce3d030107', 'hex');

/**
 * Whether the certificate's key names its curve (P-256) instead of spelling out the parameters. Node reports
 * "prime256v1" either way, so this looks at the encoded key itself.
 */
export function namedCurve(certPem: string): boolean {
  try { return new X509Certificate(certPem).raw.includes(NAMED_P256); } catch { return false; }
}

/** Same format the client shows and pins: uppercase hex pairs joined by colons. */
export function fingerprintOf(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256;
}
