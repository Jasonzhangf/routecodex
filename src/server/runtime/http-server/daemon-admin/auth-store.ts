import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type DaemonLoginRecordV1 = {
  version: 1;
  kdf: 'scrypt';
  saltB64: string;
  hashB64: string;
  createdAt: number;
};

export type DaemonLoginRecord = DaemonLoginRecordV1;

export function resolveDaemonLoginFilePath(): string {
  const override = typeof process.env.ROUTECODEX_LOGIN_FILE === 'string' ? process.env.ROUTECODEX_LOGIN_FILE.trim() : '';
  if (override) {
    return override;
  }
  return path.join(os.homedir(), '.routecodex', 'login');
}

export async function readDaemonLoginRecord(): Promise<
  { ok: true; record: DaemonLoginRecord | null } | { ok: false; error: Error }
> {
  const filePath = resolveDaemonLoginFilePath();
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) {
      return { ok: true, record: null };
    }
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: new Error('login file is not a JSON object') };
    }
    const rec = parsed as Partial<DaemonLoginRecordV1>;
    if (
      rec.version !== 1
      || rec.kdf !== 'scrypt'
      || typeof rec.saltB64 !== 'string'
      || typeof rec.hashB64 !== 'string'
    ) {
      return { ok: false, error: new Error('login file has an unsupported format') };
    }
    return { ok: true, record: rec as DaemonLoginRecordV1 };
  } catch (error: any) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { ok: true, record: null };
    }
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

export async function writeDaemonLoginRecord(password: string): Promise<DaemonLoginRecordV1> {
  const filePath = resolveDaemonLoginFilePath();
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const salt = crypto.randomBytes(16);
  const hash = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 1 << 14, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(derivedKey as Buffer);
    });
  });

  const record: DaemonLoginRecordV1 = {
    version: 1,
    kdf: 'scrypt',
    saltB64: salt.toString('base64'),
    hashB64: hash.toString('base64'),
    createdAt: Date.now()
  };
  await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return record;
}

export async function verifyDaemonPassword(password: string, record: DaemonLoginRecord): Promise<boolean> {
  if (!record || record.version !== 1 || record.kdf !== 'scrypt') {
    return false;
  }
  const salt = Buffer.from(record.saltB64, 'base64');
  const expected = Buffer.from(record.hashB64, 'base64');
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, expected.length, { N: 1 << 14, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(derivedKey as Buffer);
    });
  });
  try {
    if (derived.length !== expected.length) {
      return false;
    }
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

