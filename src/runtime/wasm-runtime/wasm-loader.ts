/**
 * WASM HubPipeline 加载器
 * 负责从 llms-engine 包加载 WASM HubPipeline 实现并提供给 Host 使用
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export type WasmHubPipelineCtor = new (config: {
  virtualRouter: unknown;
  [key: string]: unknown;
}) => WasmHubPipelineInstance;

export type WasmHubPipelineInstance = {
  execute(request: {
    id?: string;
    endpoint?: string;
    payload?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<{
    requestId: string;
    providerPayload: Record<string, unknown>;
    standardizedRequest?: Record<string, unknown>;
    processedRequest?: Record<string, unknown>;
    routingDecision?: Record<string, unknown>;
    routingDiagnostics?: Record<string, unknown>;
    target?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    nodeResults?: Array<{
      id: string;
      success: boolean;
      metadata?: Record<string, unknown>;
      error?: unknown;
    }>;
  }>;
  updateVirtualRouterConfig?(config: unknown): void;
};

// No sync loading needed in current wasm loader.

let cachedWasmHubPipelineCtor: WasmHubPipelineCtor | null = null;

/**
 * 解析 llms-engine 包路径
 */
function resolveWasmEnginePackageDir(): string {
  let currentDir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const scope = '@jsonstudio';
    const packageName = 'llms-engine';
    const candidate = path.join(currentDir, 'node_modules', scope, packageName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    currentDir = parent;
  }
  throw new Error(
    '[wasm-loader] Unable to locate llms-engine package. Please install it via npm install.'
  );
}

/**
 * 加载 WASM HubPipeline 构造函数
 */
export async function loadWasmHubPipelineCtor(): Promise<WasmHubPipelineCtor> {
  if (cachedWasmHubPipelineCtor) {
    return cachedWasmHubPipelineCtor;
  }

  const pkgDir = resolveWasmEnginePackageDir();
  const hubPipelineEntry = path.join(pkgDir, 'js', 'hub-pipeline.mjs');

  if (!fs.existsSync(hubPipelineEntry)) {
    throw new Error(
      `[wasm-loader] HubPipeline entry not found at ${hubPipelineEntry}. Please verify llms-engine installation.`
    );
  }

  try {
    const wasmModule = await import(pathToFileURL(hubPipelineEntry).href);
    const { HubPipeline: WasmHubPipeline } = wasmModule;

    if (typeof WasmHubPipeline !== 'function') {
      throw new Error('[wasm-loader] HubPipeline export is not a constructor');
    }

    cachedWasmHubPipelineCtor = WasmHubPipeline as WasmHubPipelineCtor;
    return cachedWasmHubPipelineCtor;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[wasm-loader] Failed to load WASM HubPipeline: ${detail}`);
  }
}

/**
 * 清除缓存的 WASM HubPipeline 构造函数（主要用于测试）
 */
export function clearWasmHubPipelineCache(): void {
  cachedWasmHubPipelineCtor = null;
}
