import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

export type LlmsImpl = 'ts' | 'engine';

// Built-in sharedmodule path (relative to project root) — this is the primary source.
const BUILTIN_SHARED_MODULE_REL = path.join('sharedmodule', 'llmswitch-core');

const PACKAGE_CANDIDATES_BY_IMPL: Record<LlmsImpl, string[]> = {
  ts: [
    BUILTIN_SHARED_MODULE_REL,
    path.join('node_modules', 'rcc-llmswitch-core')
  ],
  engine: [
    path.join('node_modules', 'rcc-llmswitch-engine')
  ]
};

const corePackageDirByImpl: Record<LlmsImpl, string | null> = {
  ts: null,
  engine: null
};

function getImportMetaUrlUnsafe(): string | undefined {
  try {
    return Function('return import.meta.url')() as string | undefined;
  } catch {
    return undefined;
  }
}

function isJestRuntime(): boolean {
  return typeof process.env.JEST_WORKER_ID === 'string' && process.env.JEST_WORKER_ID.length > 0;
}

function resolveCoreLoaderModulePath(): string {
  const metaUrl = getImportMetaUrlUnsafe();
  if (typeof metaUrl === 'string' && metaUrl.length > 0) {
    try {
      return new URL(metaUrl).pathname;
    } catch {
      // continue to stack / cwd fallback
    }
  }
  if (typeof __filename === 'string' && __filename.length > 0) {
    return __filename;
  }

  const stack = String(new Error().stack || '');
  for (const line of stack.split('\n')) {
    const match = line.match(/(file:\/\/[^\s)]+core-loader\.(?:ts|js)|\/[^\s)]+core-loader\.(?:ts|js))/);
    if (!match) {
      continue;
    }
    const rawPath = match[1];
    if (rawPath.startsWith('file://')) {
      try {
        return decodeURIComponent(new URL(rawPath).pathname);
      } catch {
        continue;
      }
    }
    return rawPath;
  }

  return path.join(process.cwd(), 'src/modules/llmswitch/core-loader.ts');
}

function createNodeRequire() {
  const metaUrl = getImportMetaUrlUnsafe();
  if (typeof metaUrl === 'string' && metaUrl.length > 0) {
    try {
      const requireBase = metaUrl.startsWith('file:') || path.isAbsolute(metaUrl) ? metaUrl : null;
      if (requireBase) {
        return createRequire(requireBase);
      }
    } catch {
      // continue to path fallback
    }
  }
  return createRequire(resolveCoreLoaderModulePath());
}

const nodeRequire = createNodeRequire();

function getJestRequire(): NodeJS.Require | null {
  if (!isJestRuntime()) {
    return null;
  }
  try {
    const jestRequire = Function('return typeof require === "function" ? require : null')() as NodeJS.Require | null;
    return typeof jestRequire === 'function' ? jestRequire : null;
  } catch {
    return null;
  }
}

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

export function resolveCorePackageDir(impl: LlmsImpl): string {
  const cached = corePackageDirByImpl[impl];
  if (cached) {
    return cached;
  }

  // 0) Prefer the built-in sharedmodule when it has a dist/ directory.
  //    Resolve relative to the project root (directory containing package.json).
  const moduleDir = path.dirname(resolveCoreLoaderModulePath());
  const builtinCandidates = [
    // From compiled dist/modules/llmswitch/ → ../../sharedmodule/llmswitch-core
    path.resolve(moduleDir, '..', '..', '..', BUILTIN_SHARED_MODULE_REL),
    // From project CWD (runtime launch directory)
    path.resolve(process.cwd(), BUILTIN_SHARED_MODULE_REL),
  ];
  for (const builtinDir of builtinCandidates) {
    const distDir = path.join(builtinDir, 'dist');
    if (fs.existsSync(distDir) && fs.existsSync(path.join(distDir, 'index.js'))) {
      corePackageDirByImpl[impl] = builtinDir;
      return builtinDir;
    }
  }

  // 1) Prefer Node's resolver when possible (more robust under global installs and Jest ESM).
  // Try resolution relative to this module, then relative to project CWD.
  const packageNamesByImpl: Record<LlmsImpl, string[]> = {
    ts: ['rcc-llmswitch-core'],
    engine: ['rcc-llmswitch-engine']
  };
  const baseUrls = [
    pathToFileURL(path.join(path.dirname(resolveCoreLoaderModulePath()), 'package.json')).href,
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
    path.dirname(resolveCoreLoaderModulePath()),
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

function resolveBuiltinSourceModulePath(subpath: string, impl: LlmsImpl): string | null {
  if (impl !== 'ts') {
    return null;
  }
  try {
    const packageDir = resolveCorePackageDir(impl);
    return path.join(packageDir, 'src', `${subpath.replace(/^\/*/, '').replace(/\.js$/i, '')}.ts`);
  } catch {
    return null;
  }
}

export async function importCoreModule<T = unknown>(subpath: string, impl: LlmsImpl = 'ts'): Promise<T> {
  if (isJestRuntime()) {
    const jestRequire = getJestRequire();
    const sourcePath = resolveBuiltinSourceModulePath(subpath, impl);
    if (sourcePath && jestRequire) {
      try {
        return jestRequire(sourcePath) as T;
      } catch {
        // fall through to dist-path fallback below
      }
    }
    if (sourcePath) {
      try {
        return (await import(pathToFileURL(sourcePath).href)) as T;
      } catch {
        // fall through to dist-path fallback below
      }
    }
    const modulePath = resolveCoreDistPath(subpath, impl);
    if (jestRequire) {
      try {
        return jestRequire(modulePath) as T;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? '');
        if (!/Must use import to load ES Module/i.test(message)) {
          throw error;
        }
      }
    }
    return (await import(pathToFileURL(modulePath).href)) as T;
  }
  const moduleUrl = resolveCoreModuleUrl(subpath, impl);
  try {
    return (await import(moduleUrl)) as T;
  } catch (error) {
    const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
    const sourcePath = resolveBuiltinSourceModulePath(subpath, impl);
    if (
      sourcePath
      && !isJestRuntime()
      && (
        code === 'MODULE_NOT_FOUND'
        || code === 'ERR_MODULE_NOT_FOUND'
        || code === undefined
      )
    ) {
      const require = createRequire(resolveCoreLoaderModulePath());
      return require(sourcePath) as T;
    }
    throw error;
  }
}
