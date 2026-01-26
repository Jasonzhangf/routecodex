import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export type LlmsImpl = 'ts' | 'engine' | 'wasm';

const PACKAGE_CANDIDATES_BY_IMPL: Record<LlmsImpl, string[]> = {
  ts: [
    path.join('node_modules', '@jsonstudio', 'llms'),
    path.join('node_modules', 'rcc-llmswitch-core')
  ],
  engine: [
    path.join('node_modules', '@jsonstudio', 'llms-engine')
  ],
  wasm: [
    // NOTE: llms-wasm is published under @jsonstudio/llms-engine.
    // This alias keeps host-side code readable.
    path.join('node_modules', '@jsonstudio', 'llms-engine')
  ]
};

const corePackageDirByImpl: Record<LlmsImpl, string | null> = {
  ts: null,
  engine: null
  ,
  wasm: null
};

function resolveCorePackageDir(impl: LlmsImpl): string {
  const cached = corePackageDirByImpl[impl];
  if (cached) {
    return cached;
  }
  let currentDir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    for (const pkgPath of PACKAGE_CANDIDATES_BY_IMPL[impl]) {
      const candidate = path.join(currentDir, pkgPath);
      if (fs.existsSync(candidate)) {
        corePackageDirByImpl[impl] = candidate;
        return candidate;
      }
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    currentDir = parent;
  }
  const targets = PACKAGE_CANDIDATES_BY_IMPL[impl].map((pkg) => path.join('<project>', pkg)).join(' 或 ');
  throw new Error(
    `[llmswitch-core-loader] 无法定位 llmswitch 核心库(${impl})，请执行 npm install 以确保 ${targets} 存在。`
  );
}

function resolveCoreDistPath(subpath: string, impl: LlmsImpl): string {
  const clean = subpath.replace(/^\/*/, '').replace(/\.js$/i, '');
  const baseDir = resolveCorePackageDir(impl);
  const distDir = path.join(baseDir, 'dist');

  // NOTE:
  // - TS / engine use dist/*.js modules.
  // - WASM package (@jsonstudio/llms-engine) exposes entrypoints under js/*.js.
  const candidate =
    impl === 'wasm'
      ? path.join(baseDir, 'js', `${clean}.mjs`)
      : path.join(distDir, `${clean}.js`);

  if (!fs.existsSync(candidate)) {
    throw new Error(`[llmswitch-core-loader] 未找到 ${candidate}，请确认对应核心库包含该模块。`);
  }
  return candidate;
}

export function resolveCoreModulePath(subpath: string, impl: LlmsImpl = 'ts'): string {
  return resolveCoreDistPath(subpath, impl);
}

export function resolveCoreModuleUrl(subpath: string, impl: LlmsImpl = 'ts'): string {
  const modulePath = resolveCoreDistPath(subpath, impl);
  return pathToFileURL(modulePath).href;
}

export async function importCoreModule<T = unknown>(subpath: string, impl: LlmsImpl = 'ts'): Promise<T> {
  const moduleUrl = resolveCoreModuleUrl(subpath, impl);
  return (await import(moduleUrl)) as T;
}
