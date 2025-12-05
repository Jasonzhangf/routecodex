import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { importCoreModule } from '../../../modules/llmswitch/core-loader.js';

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  const root = path.parse(dir).root;
  while (dir && dir !== root) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.resolve(dir, '..');
  }
  return startDir;
}

export function resolveRepoRoot(currentModuleUrl: string): string {
  const sourceUrl = currentModuleUrl || import.meta.url;
  const current = fileURLToPath(sourceUrl);
  const dirname = path.dirname(current);
  return findRepoRoot(dirname);
}

export async function loadLlmswitchModule<T = unknown>(_repoRoot: string, subpath: string): Promise<T> {
  return await importCoreModule(subpath);
}
