import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

let corePackageDir: string | null = null;

function resolveCorePackageDir(): string {
  if (corePackageDir) return corePackageDir;
  let currentDir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(currentDir, 'node_modules', 'rcc-llmswitch-core');
    if (fs.existsSync(candidate)) {
      corePackageDir = candidate;
      return corePackageDir;
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    currentDir = parent;
  }
  throw new Error('[llmswitch-core-loader] 无法定位 rcc-llmswitch-core 包，请先执行 npm install。');
}

function resolveCoreDistPath(subpath: string): string {
  const clean = subpath.replace(/^\/*/, '').replace(/\.js$/i, '');
  const distDir = path.join(resolveCorePackageDir(), 'dist');
  const candidate = path.join(distDir, `${clean}.js`);
  if (!fs.existsSync(candidate)) {
    throw new Error(`[llmswitch-core-loader] 未找到 ${candidate}，请确认 rcc-llmswitch-core 发布版本包含该模块。`);
  }
  return candidate;
}

export function resolveCoreModuleUrl(subpath: string): string {
  const modulePath = resolveCoreDistPath(subpath);
  return pathToFileURL(modulePath).href;
}

export async function importCoreModule<T = any>(subpath: string): Promise<T> {
  const moduleUrl = resolveCoreModuleUrl(subpath);
  return (await import(moduleUrl)) as T;
}
