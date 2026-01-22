import type { TargetMetadata } from '../../../modules/pipeline/orchestrator/pipeline-context.js';

export interface ProviderRuntimeMetadata {
  requestId?: string;
  pipelineId?: string;
  routeName?: string;
  providerId?: string;
  providerKey?: string;
  runtimeKey?: string;
  providerType?: string;
  providerFamily?: string;
  providerProtocol?: string;
  modelId?: string;
  metadata?: Record<string, unknown>;
  target?: TargetMetadata;
  compatibilityProfile?: string;
  /**
   * Runtime metadata is a dynamic carrier for provider/request hints.
   * Keep an index signature so transport/provider code can attach extra fields
   * (e.g. streaming flags, client originator, counters) without fighting TS.
   */
  [key: string]: unknown;
}

const PROVIDER_RUNTIME_SYMBOL = Symbol.for('routecodex.providerRuntime');

export function attachProviderRuntimeMetadata(
  payload: Record<string, unknown>,
  metadata: ProviderRuntimeMetadata
): void {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  const previous = Reflect.get(payload, PROVIDER_RUNTIME_SYMBOL) as ProviderRuntimeMetadata | undefined;
  const merged = previous ? { ...previous, ...metadata } : { ...metadata };
  Object.defineProperty(payload, PROVIDER_RUNTIME_SYMBOL, {
    value: merged,
    enumerable: false,
    configurable: true,
    writable: true
  });
}

export function extractProviderRuntimeMetadata(source: unknown): ProviderRuntimeMetadata | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  const meta = Reflect.get(source as object, PROVIDER_RUNTIME_SYMBOL);
  return meta && typeof meta === 'object' ? (meta as ProviderRuntimeMetadata) : undefined;
}

export { PROVIDER_RUNTIME_SYMBOL };
