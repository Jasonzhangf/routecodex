import fs from 'node:fs/promises';
import path from 'node:path';

export async function readJsonFile(filePath: string): Promise<unknown> {
  const buf = await fs.readFile(filePath);
  return JSON.parse(buf.toString('utf8'));
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.tmp_${path.basename(filePath)}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const payload = JSON.stringify(value, null, 2);
  await fs.writeFile(tmp, payload, 'utf8');
  await fs.rename(tmp, filePath);
}
