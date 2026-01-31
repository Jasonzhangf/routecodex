import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export type LlmsImpl = 'ts' | 'engine';

const PACKAGE_CANDIDATES_BY_IMPL: Record<LlmsImpl, string[]> = {
  ts: [
    path.join('node_modules', '@jsonstudio', 'llms'),
    path.join('node_modules', 'rcc-llmswitch-core')
  ],
  engine: [
    path.join('node_modules', '@jsonstudio', 'llms-engine'),
    path.join('node_modules', 'rcc-llmswitch-engine')
  ]
};

const corePackageDirByImpl: Record<LlmsImpl, string | null> = {
  ts: null,
  engine: null
};

// WASM 模块配置（100% 黑盒对齐的模块）
type WasmModuleConfig = {
  tsPath: string;
  wasmExport: string;
  coverage: string;
  note: string;
};

let wasmModulesConfig: { enabled: boolean; shadowMode: boolean; wasmModules: WasmModuleConfig[] } | null = null;

function loadWasmModulesConfig(): void {
  if (wasmModulesConfig !== null) {
    return;
  }
  try {
    const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'llms-engine-config.json');
    const configContent = fs.readFileSync(configPath, 'utf-8');
    wasmModulesConfig = JSON.parse(configContent);
  } catch {
    // 配置文件不存在或读取失败，默认禁用 WASM
    wasmModulesConfig = { enabled: false, shadowMode: false, wasmModules: [] };
  }
}

/**
 * 检查指定 subpath 是否有 100% 对齐的 WASM 实现
 */
export function hasWasmImplementation(subpath: string): boolean {
  loadWasmModulesConfig();
  if (!wasmModulesConfig!.enabled) {
    return false;
  }
  return wasmModulesConfig!.wasmModules.some((mod) => {
    const normalizedTsPath = mod.tsPath.replace(/^\/*/, '').replace(/\.js$/i, '');
    const normalizedSubpath = subpath.replace(/^\/*/, '').replace(/\.js$/i, '');
    return (
      normalizedSubpath === normalizedTsPath ||
      normalizedSubpath.startsWith(`${normalizedTsPath}/`)
    );
  });
}

export function getWasmConfig(): typeof wasmModulesConfig {
  loadWasmModulesConfig();
  return wasmModulesConfig;
}

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
