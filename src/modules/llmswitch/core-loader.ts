import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export type LlmsImpl = 'ts' | 'engine';

const PACKAGE_CANDIDATES_BY_IMPL: Record<LlmsImpl, string[]> = {
  ts: [
    path.join('node_modules', '@jsonstudio', 'llms'),
    path.join('node_modules', 'rcc-llmswitch-core')
  ],
  engine: [
    path.join('node_modules', '@jsonstudio', 'llms-engine')
  ]
};

const corePackageDirByImpl: Record<LlmsImpl, string | null> = {
  ts: null,
  engine: null
};

function findPackageRootFromEntry(entryPath: string): string | null {
  let current = path.dirname(entryPath);
  while (true) {
    const pkgJson = path.join(current, 'package.json');
    if (fs.existsSync(pkgJson)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function tryResolvePackageRootViaRequire(packageName: string, baseUrl: string): string | null {
  try {
    const require = createRequire(baseUrl);
    const entry = require.resolve(packageName);
    return findPackageRootFromEntry(entry);
  } catch {
    return null;
  }
}

function resolveCorePackageDir(impl: LlmsImpl): string {
  const cached = corePackageDirByImpl[impl];
  if (cached) {
    return cached;
  }

  // 1) Prefer Node's resolver when possible (more robust under global installs and Jest ESM).
  // Try resolution relative to this module, then relative to project CWD.
  const packageNamesByImpl: Record<LlmsImpl, string[]> = {
    ts: ['@jsonstudio/llms', 'rcc-llmswitch-core'],
    engine: ['@jsonstudio/llms-engine']
  };
  const baseUrls = [
    import.meta.url,
    pathToFileURL(path.join(process.cwd(), 'package.json')).href
  ];
  for (const name of packageNamesByImpl[impl]) {
    for (const baseUrl of baseUrls) {
      const root = tryResolvePackageRootViaRequire(name, baseUrl);
      if (root) {
        corePackageDirByImpl[impl] = root;
        return root;
      }
    }
  }

  // 2) Fallback: walk up and find node_modules relative to runtime/module paths.
  const startDirs = [
    // Normal runtime: resolve from this module's location.
    path.dirname(fileURLToPath(import.meta.url)),
    // Jest/ts-jest ESM can execute from virtualized cache paths; fall back to project CWD.
    process.cwd()
  ];
  for (const startDir of startDirs) {
    let currentDir = startDir;
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
  }
  const targets = PACKAGE_CANDIDATES_BY_IMPL[impl].map((pkg) => path.join('<project>', pkg)).join(' 或 ');
  throw new Error(
    `[llmswitch-core-loader] 无法定位 llmswitch 核心库(${impl})，请执行 npm install 以确保 ${targets} 存在。`
  );
}

function resolveCoreDistPath(subpath: string, impl: LlmsImpl): string {
  const clean = subpath.replace(/^\/*/, '').replace(/\.js$/i, '');
  const distDir = path.join(resolveCorePackageDir(impl), 'dist');
  const candidate = path.join(distDir, `${clean}.js`);
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
