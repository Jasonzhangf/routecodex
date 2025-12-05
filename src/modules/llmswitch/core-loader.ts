import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const PACKAGE_CANDIDATES = [
  path.join('node_modules', '@jsonstudio', 'llms'),
  path.join('node_modules', 'rcc-llmswitch-core')
];

let corePackageDir: string | null = null;

function resolveCorePackageDir(): string {
  if (corePackageDir) {
    return corePackageDir;
  }
  let currentDir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    for (const pkgPath of PACKAGE_CANDIDATES) {
      const candidate = path.join(currentDir, pkgPath);
      if (fs.existsSync(candidate)) {
        corePackageDir = candidate;
        return corePackageDir;
      }
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    currentDir = parent;
  }
  const targets = PACKAGE_CANDIDATES.map((pkg) => path.join('<project>', pkg)).join(' 或 ');
  throw new Error(
    `[llmswitch-core-loader] 无法定位 llmswitch 核心库，请执行 npm install 或 npm run llmswitch:link 以确保 ${targets} 存在。`
  );
}

function resolveCoreDistPath(subpath: string): string {
  const clean = subpath.replace(/^\/*/, '').replace(/\.js$/i, '');
  const distDir = path.join(resolveCorePackageDir(), 'dist');
  const candidate = path.join(distDir, `${clean}.js`);
  if (!fs.existsSync(candidate)) {
    throw new Error(`[llmswitch-core-loader] 未找到 ${candidate}，请确认 @jsonstudio/llms 发布版本包含该模块。`);
  }
  return candidate;
}

export function resolveCoreModuleUrl(subpath: string): string {
  const modulePath = resolveCoreDistPath(subpath);
  return pathToFileURL(modulePath).href;
}

export async function importCoreModule<T = unknown>(subpath: string): Promise<T> {
  const moduleUrl = resolveCoreModuleUrl(subpath);
  return (await import(moduleUrl)) as T;
}
