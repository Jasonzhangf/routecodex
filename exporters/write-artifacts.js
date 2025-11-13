import fs from 'fs/promises';
import path from 'path';

export async function writeArtifacts(outDir, arts) {
  const out = outDir || process.cwd();
  await fs.mkdir(out, { recursive: true });
  const entries = Object.entries(arts || {});
  for (const [k, v] of entries) {
    const file = path.join(out, `${k}.json`);
    await fs.writeFile(file, JSON.stringify(v, null, 2), 'utf-8');
  }
  return true;
}

