import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

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
  try {
    const current = fileURLToPath(currentModuleUrl);
    const dirname = path.dirname(current);
    return findRepoRoot(dirname);
  } catch {
    return process.cwd();
  }
}

export async function loadLlmswitchModule<T = any>(repoRoot: string, subpath: string): Promise<T> {
  const target = path.join(repoRoot, 'sharedmodule', 'llmswitch-core', 'dist', subpath);
  const url = pathToFileURL(target).href;
  return (await import(url)) as T;
}
