import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export type LlmsImpl = 'ts' | 'engine';

// WASM 100% CI 覆盖的模块列表（基于 llms-wasm compare-all-modules.mjs 40/40 验证通过）
// 这些模块默认使用 WASM 版本，TS 版本作为 shadow 对比
// 
// 策略：
// - 只有在 CI 中验证 100% 对齐的模块才列入此表
// - 未列入的模块继续使用 TS 实现，保证稳定性
// 注：当前 llms-wasm-sync 中已完成黑盒对齐的模块（100% passed）：
// - conversion/shared/anthropic-utils
// - conversion/codecs/anthropic-openai-codec
// - conversion/sse/responses-json-to-sse-converter
// - conversion/sse/chat-json-to-sse-converter
// - conversion/sse/responses-sse-to-json-converter
// - conversion/sse/chat-sse-to-json-converter
// - conversion/hub/operation-table/semantic-mappers/anthropic-mapper
// 
// 这些模块对应 llmswitch-core 的路径（简化为前缀匹配）：
const WASM_COVERED_PREFIXES = [
  'conversion/shared/anthropic-utils',
  'conversion/codecs/anthropic-openai-codec',
  'conversion/sse/responses-json-to-sse-converter',
  'conversion/sse/responses-sse-to-json-converter',
  'conversion/sse/chat-json-to-sse-converter',
  'conversion/sse/chat-sse-to-json-converter',
  'conversion/hub/operation-table/semantic-mappers/anthropic-mapper',
];

export function isWasmCoveredModule(subpath: string): boolean {
  const normalized = subpath.replace(/^\/+/, '').replace(/\.js$/i, '');
  return WASM_COVERED_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
  );
}

const PACKAGE_CANDIDATES_BY_IMPL: Record<LlmsImpl, string[]> = {
  ts: [
    path.join('node_modules', '@jsonstudio', 'llms'),
    path.join('node_modules', 'rcc-llmswitch-core')
  ],
  engine: [
    // WASM 版本优先查找 @jsonstudio/llms 自带的 WASM 构建
    path.join('node_modules', '@jsonstudio', 'llms'),
    path.join('node_modules', '@jsonstudio', 'llms-engine')
  ]
};

const corePackageDirByImpl: Record<LlmsImpl, string | null> = {
  ts: null,
  engine: null
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
  const clean = subpath.replace(/^\/*/,'').replace(/\.js$/i, '');
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
