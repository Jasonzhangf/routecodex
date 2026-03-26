import type { PipelineDebugLogger } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type {
  DebugLogEntry,
  TransformationLogEntry,
  ProviderRequestLogEntry
} from '../../../modules/pipeline/utils/debug-logger.js';

export function createNoopPipelineLogger(): PipelineDebugLogger {
  const noop = () => {};
  const emptyLogs = (): {
    general: DebugLogEntry[];
    transformations: TransformationLogEntry[];
    provider: ProviderRequestLogEntry[];
  } => ({
    general: [],
    transformations: [],
    provider: []
  });
  const emptyList = <T>(): T[] => [];
  const emptyStats = () => ({
    totalLogs: 0,
    logsByLevel: {},
    logsByCategory: {},
    logsByPipeline: {},
    transformationCount: 0,
    providerRequestCount: 0
  });
  return {
    logModule: noop,
    logError: noop,
    logDebug: noop,
    logPipeline: noop,
    logRequest: noop,
    logResponse: noop,
    logTransformation: noop,
    logProviderRequest: noop,
    getRequestLogs: emptyLogs,
    getPipelineLogs: emptyLogs,
    getRecentLogs: () => emptyList<DebugLogEntry>(),
    getTransformationLogs: () => emptyList<TransformationLogEntry>(),
    getProviderLogs: () => emptyList<ProviderRequestLogEntry>(),
    getStatistics: emptyStats,
    clearLogs: noop,
    exportLogs: () => [],
    log: noop
  };
}
