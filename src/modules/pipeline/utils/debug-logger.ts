import type { LogData } from '../../../types/common-types.js';
import { ColoredLogger } from './colored-logger.js';

export type DebugLogEntry = {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  pipelineId?: string;
  category?: string;
  message?: string;
  data?: LogData;
};

export type TransformationLogEntry = DebugLogEntry & {
  ruleId?: string;
  stage?: string;
};

export type ProviderRequestLogEntry = DebugLogEntry & {
  request?: LogData;
  response?: LogData;
};

type LoggerOptions = {
  maxEntries?: number;
  enableConsoleLogging?: boolean;
};

const DEFAULT_OPTIONS: Required<LoggerOptions> = {
  maxEntries: 500,
  enableConsoleLogging: false
};

export class PipelineDebugLogger {
  private readonly options: Required<LoggerOptions>;
  private readonly requestLogs = new Map<string, DebugLogEntry[]>();
  private readonly pipelineLogs = new Map<string, DebugLogEntry[]>();
  private readonly transformations: TransformationLogEntry[] = [];
  private readonly providerLogs: ProviderRequestLogEntry[] = [];
  private readonly recentLogs: DebugLogEntry[] = [];
  private colored?: ColoredLogger;

  constructor(_config?: unknown, options?: LoggerOptions) {
    const isDev = String(process.env.BUILD_MODE || process.env.RCC_BUILD_MODE || 'release').toLowerCase() === 'dev';
    this.colored = new ColoredLogger({ isDev });
    this.options = {
      maxEntries: options?.maxEntries ?? DEFAULT_OPTIONS.maxEntries,
      enableConsoleLogging: options?.enableConsoleLogging ?? DEFAULT_OPTIONS.enableConsoleLogging
    };
  }

  logModule(module: string, action: string, data?: LogData): void {
    if (this.colored) { this.colored.logModule(module, action, data); return; }
    this.record({
      timestamp: Date.now(),
      level: 'info',
      pipelineId: module,
      category: action,
      data
    });
  }

  logError(error: unknown, context?: LogData): void {
    if (this.colored) { this.colored.logProviderRequest('', 'request-error', { error, context }); return; }
    this.record({
      timestamp: Date.now(),
      level: 'error',
      message: error instanceof Error ? error.message : String(error ?? 'Unknown error'),
      data: context
    });
  }

  logDebug(message: string, data?: LogData): void {
    this.record({ timestamp: Date.now(), level: 'debug', message, data });
  }

  logPipeline(pipelineId: string, action: string, data?: LogData): void {
    if (this.colored) { this.colored.logModule(pipelineId, action, data); return; }
    this.appendScoped(this.pipelineLogs, pipelineId, {
      timestamp: Date.now(),
      level: 'info',
      pipelineId,
      category: action,
      data
    });
  }

  logRequest(requestId: string, action: string, data?: LogData): void {
    if (this.colored) { this.colored.logProviderRequest(requestId, action as any, data); return; }
    this.appendScoped(this.requestLogs, requestId, {
      timestamp: Date.now(),
      level: 'info',
      pipelineId: requestId,
      category: action,
      data
    });
  }

  logVirtualRouterHit(routeName: string, providerKey: string, model?: string): void {
    if (this.colored) {
      this.colored.logVirtualRouterHit(routeName, providerKey, model);
      return;
    }
    this.record({
      timestamp: Date.now(),
      level: 'info',
      category: 'virtual-router-hit',
      message: `${routeName} -> ${providerKey}${model ? `.${  model}` : ''}`
    });
  }

  logResponse(requestId: string, action: string, data?: LogData): void {
    this.logRequest(requestId, action, data);
  }

  logTransformation(requestId: string, action: string, before?: LogData, after?: LogData): void {
    this.transformations.push({
      timestamp: Date.now(),
      level: 'info',
      pipelineId: requestId,
      category: action,
      data: { before, after }
    });
    this.enforceLimit(this.transformations);
  }

  logProviderRequest(requestId: string, action: string, request?: LogData, response?: LogData): void {
    if (this.colored) { this.colored.logProviderRequest(requestId, action as any, { request, response }); return; }
    this.providerLogs.push({
      timestamp: Date.now(),
      level: 'info',
      pipelineId: requestId,
      category: action,
      request,
      response
    });
    this.enforceLimit(this.providerLogs);
  }

  getRequestLogs(requestId: string) {
    return {
      general: [...(this.requestLogs.get(requestId) ?? [])],
      transformations: this.transformations.filter(entry => entry.pipelineId === requestId),
      provider: this.providerLogs.filter(entry => entry.pipelineId === requestId)
    };
  }

  getPipelineLogs(pipelineId: string) {
    return {
      general: [...(this.pipelineLogs.get(pipelineId) ?? [])],
      transformations: this.transformations.filter(entry => entry.pipelineId === pipelineId),
      provider: this.providerLogs.filter(entry => entry.pipelineId === pipelineId)
    };
  }

  getRecentLogs(count = 50): DebugLogEntry[] {
    return this.recentLogs.slice(-count);
  }

  getTransformationLogs(): TransformationLogEntry[] {
    return [...this.transformations];
  }

  getProviderLogs(): ProviderRequestLogEntry[] {
    return [...this.providerLogs];
  }

  getStatistics() {
    const summary: Record<string, number> = {};
    for (const entry of this.recentLogs) {
      summary[entry.level] = (summary[entry.level] || 0) + 1;
    }
    return {
      totalLogs: this.recentLogs.length,
      logsByLevel: summary,
      logsByCategory: this.aggregateByField('category'),
      logsByPipeline: this.aggregateByField('pipelineId'),
      transformationCount: this.transformations.length,
      providerRequestCount: this.providerLogs.length
    };
  }

  clearLogs(): void {
    this.requestLogs.clear();
    this.pipelineLogs.clear();
    this.transformations.length = 0;
    this.providerLogs.length = 0;
    this.recentLogs.length = 0;
  }

  exportLogs(format: 'json' | 'csv' = 'json'): DebugLogEntry[] | string[] {
    if (format === 'csv') {
      return this.recentLogs.map(entry => `${entry.timestamp},${entry.level},${entry.category ?? ''},${entry.message ?? ''}`);
    }
    return this.recentLogs.map(entry => ({ ...entry }));
  }

  log(level: DebugLogEntry['level'], pipelineId: string, category: string, message: string, data?: LogData): void {
    this.record({ timestamp: Date.now(), level, pipelineId, category, message, data });
  }

  private record(entry: DebugLogEntry): void {
    this.recentLogs.push(entry);
    this.enforceLimit(this.recentLogs);
    if (this.options.enableConsoleLogging) {
      console.log('[PipelineDebugLogger]', entry.level.toUpperCase(), entry.category ?? entry.message ?? '', entry.data ?? '');
    }
  }

  private appendScoped(map: Map<string, DebugLogEntry[]>, key: string, entry: DebugLogEntry): void {
    const bucket = map.get(key) ?? [];
    bucket.push(entry);
    this.enforceLimit(bucket);
    map.set(key, bucket);
  }

  private enforceLimit(collection: DebugLogEntry[]): void {
    const { maxEntries } = this.options;
    while (collection.length > maxEntries) {
      collection.shift();
    }
  }

  private aggregateByField(field: keyof DebugLogEntry): Record<string, number> {
    const result: Record<string, number> = {};
    for (const entry of this.recentLogs) {
      const key = String(entry[field] ?? '');
      if (!key) {
        continue;
      }
      result[key] = (result[key] || 0) + 1;
    }
    return result;
  }
}
