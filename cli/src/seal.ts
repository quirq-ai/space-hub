// Runner tokens are sealed before they reach the database: AES-256-GCM with SPACEHUB_SECRET_KEY, which lives in
// the environment and not in /data, so the hub's backups (sub-hubs copy /data) hold only ciphertext.
// A sealed value is base64 of iv (12 bytes) | ciphertext | tag (16 bytes).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV = 12;
const TAG = 16;

/** The key from SPACEHUB_SECRET_KEY (base64 of at least 32 bytes), or null when it is not set: runners are off. */
export function sealKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = (env.SPACEHUB_SECRET_KEY ?? '').trim();
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length < 32) throw new Error('SPACEHUB_SECRET_KEY must be base64 of at least 32 bytes');
  return key.subarray(0, 32);
}

export function seal(key: Buffer, plain: string): string {
  const iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64');
}

export function open(key: Buffer, sealed: string): string {
  try {
    const all = Buffer.from(sealed, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, all.subarray(0, IV));
    decipher.setAuthTag(all.subarray(all.length - TAG));
    return Buffer.concat([decipher.update(all.subarray(IV, all.length - TAG)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error("This runner's token cannot be read; connect it again.");
  }
}
