import { ProviderFactory } from '../../modules/pipeline/modules/provider/v2/core/provider-factory.js';
import {
  attachProviderRuntimeMetadata,
  extractProviderRuntimeMetadata
} from '../../modules/pipeline/modules/provider/v2/core/provider-runtime-metadata.js';
import type { ModuleDependencies } from '../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { PipelineDebugLogger } from '../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { IProviderV2 } from '../../modules/pipeline/modules/provider/v2/api/provider-types.js';
import type {
  ExecutionHarness,
  ProviderHarnessExecuteInput,
  ProviderHarnessResult,
  ProviderHarnessRuntime
} from '../types.js';

function deepClone<T>(value: T): T {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function createNoopLogger(): PipelineDebugLogger {
  const noop = () => {};
  return {
    logModule: noop,
    logError: noop,
    logDebug: noop,
    logPipeline: noop,
    logRequest: noop,
    logResponse: noop,
    logTransformation: noop,
    logProviderRequest: noop,
    getRequestLogs: () => ({ general: [], transformations: [], provider: [] }),
    getPipelineLogs: () => ({ general: [], transformations: [], provider: [] }),
    getRecentLogs: () => [],
    getTransformationLogs: () => [],
    getProviderLogs: () => [],
    getStatistics: () => ({
      totalLogs: 0,
      logsByLevel: {},
      logsByCategory: {},
      logsByPipeline: {},
      transformationCount: 0,
      providerRequestCount: 0
    }),
    clearLogs: noop,
    exportLogs: () => [],
    log: noop
  };
}

function createDefaultDependencies(): ModuleDependencies {
  const noop = () => {};
  const logger = createNoopLogger();
  const errorHandlingCenter = {
    handleError: async () => {},
    createContext: () => ({}),
    getStatistics: () => ({})
  };
  const debugCenter = {
    logDebug: noop,
    logError: noop,
    logModule: noop,
    processDebugEvent: noop,
    getLogs: () => []
  };
  return {
    logger,
    errorHandlingCenter,
    debugCenter
  } as ModuleDependencies;
}

type ProviderRuntimeInput = ProviderHarnessRuntime & Record<string, unknown>;

export class ProviderPreprocessHarness
  implements ExecutionHarness<ProviderHarnessExecuteInput, ProviderHarnessResult>
{
  readonly id = 'provider.preprocess';
  private readonly providers = new Map<string, IProviderV2>();

  constructor(private readonly defaultDependencies?: ModuleDependencies) {}

  private async ensureProvider(runtime: ProviderRuntimeInput, dependencies?: ModuleDependencies): Promise<IProviderV2> {
    const key = runtime.runtimeKey || `${runtime.providerKey}:${runtime.defaultModel}`;
    const cached = this.providers.get(key);
    if (cached) return cached;
    const provider = ProviderFactory.createProviderFromRuntime(runtime as any, dependencies ?? this.defaultDependencies ?? createDefaultDependencies());
    if (typeof provider.initialize === 'function') {
      await provider.initialize();
    }
    this.providers.set(key, provider);
    return provider;
  }

  async executeForward(input: ProviderHarnessExecuteInput): Promise<ProviderHarnessResult> {
    const provider = await this.ensureProvider(input.runtime, input.dependencies);
    const cloned = deepClone(input.request);
    attachProviderRuntimeMetadata(cloned, input.metadata as any);
    const context = typeof (provider as any).createContext === 'function' ? (provider as any).createContext(cloned) : undefined;
    if (input.action === 'postprocess' && typeof (provider as any).postprocessResponse === 'function') {
      const payload = await (provider as any).postprocessResponse(cloned, context);
      const runtimeMeta = extractProviderRuntimeMetadata(cloned);
      return { payload, context: runtimeMeta ? ({ ...runtimeMeta } as Record<string, unknown>) : undefined };
    }
    const payload =
      typeof (provider as any).preprocessRequest === 'function'
        ? await (provider as any).preprocessRequest(cloned, context)
        : cloned;
    const runtimeMeta = extractProviderRuntimeMetadata(cloned);
    return { payload, context: runtimeMeta ? ({ ...runtimeMeta } as Record<string, unknown>) : undefined };
  }
}
