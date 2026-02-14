/**
 * Routing Integrations Bridge
 *
 * Virtual router bootstrap + hub pipeline constructor + host base dir resolver.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { importCoreDist, resolveImplForSubpath } from './module-loader.js';
import type { AnyRecord, LlmsImpl } from './module-loader.js';

type VirtualRouterBootstrapModule = {
  bootstrapVirtualRouterConfig?: (input: AnyRecord) => AnyRecord;
};

export async function bootstrapVirtualRouterConfig(input: AnyRecord): Promise<AnyRecord> {
  const mod = await importCoreDist<VirtualRouterBootstrapModule>('router/virtual-router/bootstrap');
  const fn = mod.bootstrapVirtualRouterConfig;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] bootstrapVirtualRouterConfig not available');
  }
  return fn(input);
}

type HubPipelineModule = {
  HubPipeline?: new (config: AnyRecord) => AnyRecord;
};

type HubPipelineCtorAny = new (config: AnyRecord) => AnyRecord;

const cachedHubPipelineCtorByImpl: Record<LlmsImpl, HubPipelineCtorAny | null> = {
  ts: null,
  engine: null
};

export async function getHubPipelineCtor(): Promise<HubPipelineCtorAny> {
  const impl = resolveImplForSubpath('conversion/hub/pipeline/hub-pipeline');
  if (!cachedHubPipelineCtorByImpl[impl]) {
    const mod = await importCoreDist<HubPipelineModule>('conversion/hub/pipeline/hub-pipeline', impl);
    const Ctor = mod.HubPipeline;
    if (typeof Ctor !== 'function') {
      throw new Error('[llmswitch-bridge] HubPipeline constructor not available');
    }
    cachedHubPipelineCtorByImpl[impl] = Ctor;
  }
  return cachedHubPipelineCtorByImpl[impl]!;
}

export async function getHubPipelineCtorForImpl(impl: LlmsImpl): Promise<HubPipelineCtorAny> {
  if (!cachedHubPipelineCtorByImpl[impl]) {
    const mod = await importCoreDist<HubPipelineModule>('conversion/hub/pipeline/hub-pipeline', impl);
    const Ctor = mod.HubPipeline;
    if (typeof Ctor !== 'function') {
      throw new Error('[llmswitch-bridge] HubPipeline constructor not available');
    }
    cachedHubPipelineCtorByImpl[impl] = Ctor;
  }
  return cachedHubPipelineCtorByImpl[impl]!;
}

export function resolveBaseDir(): string {
  const env = String(process.env.ROUTECODEX_BASEDIR || process.env.RCC_BASEDIR || '').trim();
  if (env) return env;
  try {
    const __filename = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(__filename), '../../../..');
  } catch {
    return process.cwd();
  }
}
