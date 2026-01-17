import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

type UsageShape = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type ProviderSample = {
  providerKey?: string;
  providerType?: string;
  model?: string;
  startTime: number;
};

export interface ProviderStatsBucket {
  providerKey: string;
  providerType?: string;
  model?: string;
  requestCount: number;
  errorCount: number;
  totalLatencyMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalOutputTokens: number;
  firstRequestAt: number;
  lastRequestAt: number;
}

export interface ProviderStatsView extends ProviderStatsBucket {
  averageLatencyMs: number;
  averagePromptTokens: number;
  averageCompletionTokens: number;
  averageOutputTokens: number;
}

export interface ToolStatsBucket {
  toolName: string;
  callCount: number;
  responseCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface ToolStatsSnapshot {
  totalCalls: number;
  totalResponses: number;
  byToolName: Record<string, ToolStatsBucket>;
  byProviderKey: Record<string, {
    providerKey: string;
    model?: string;
    totalCalls: number;
    totalResponses: number;
    byToolName: Record<string, ToolStatsBucket>;
  }>;
}

export interface StatsSnapshot {
  generatedAt: number;
  uptimeMs: number;
  totals: ProviderStatsView[];
  tools?: ToolStatsSnapshot;
}

export interface HistoricalStatsSnapshot {
  generatedAt: number;
  snapshotCount: number;
  sampleCount: number;
  totals: ProviderStatsView[];
}

export type StatsPersistOptions = {
  logPath?: string;
  reason?: string;
};

const DEFAULT_STATS_LOG_PATH = path.join(os.homedir(), '.routecodex', 'logs', 'provider-stats.jsonl');

export class StatsManager {
  private readonly inflight = new Map<string, ProviderSample>();
  private readonly buckets = new Map<string, ProviderStatsBucket>();
  private readonly toolBuckets = new Map<string, ToolStatsBucket>();
  private readonly toolBucketsByProvider = new Map<string, Map<string, ToolStatsBucket>>();
  private readonly toolProviderTotals = new Map<string, { providerKey: string; model?: string; totalCalls: number; totalResponses: number }>();
  private totalToolCalls = 0;
  private totalToolResponses = 0;
  private statsLogPath: string;
  private historicalBuckets = new Map<string, ProviderStatsBucket>();
  private historicalToolAggregate = new Map<string, ToolStatsBucket>();
  private historicalToolByProvider = new Map<string, {
    providerKey: string;
    model?: string;
    totalCalls: number;
    totalResponses: number;
    byToolName: Map<string, ToolStatsBucket>;
  }>();
  private historicalSnapshotCount = 0;
  private historicalSampleCount = 0;
  private historicalLoaded = false;

  constructor() {
    this.statsLogPath = this.resolveLogPath();
    this.loadHistoricalFromDisk(this.statsLogPath, true);
  }

  recordRequestStart(requestId: string): void {
    if (!requestId) {
      return;
    }
    this.inflight.set(requestId, {
      startTime: Date.now()
    });
  }

  bindProvider(
    requestId: string,
    meta: { providerKey?: string; providerType?: string; model?: string }
  ): void {
    if (!requestId) {
      return;
    }
    const sample = this.inflight.get(requestId);
    if (sample) {
      if (meta.providerKey) {sample.providerKey = meta.providerKey;}
      if (meta.providerType) {sample.providerType = meta.providerType;}
      if (meta.model) {sample.model = meta.model;}
      return;
    }
    this.inflight.set(requestId, {
      startTime: Date.now(),
      ...meta
    });
  }

  recordCompletion(
    requestId: string,
    options?: { usage?: UsageShape; error?: boolean }
  ): void {
    if (!requestId) {
      return;
    }
    const sample = this.inflight.get(requestId);
    this.inflight.delete(requestId);
    if (!sample?.providerKey) {
      return;
    }
    const key = this.composeBucketKey(sample.providerKey, sample.model);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      const now = Date.now();
      bucket = {
        providerKey: sample.providerKey,
        providerType: sample.providerType,
        model: sample.model,
        requestCount: 0,
        errorCount: 0,
        totalLatencyMs: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalOutputTokens: 0,
        firstRequestAt: sample.startTime ?? now,
        lastRequestAt: now
      } satisfies ProviderStatsBucket;
      this.buckets.set(key, bucket);
    }
    bucket.requestCount += 1;
    if (options?.error) {
      bucket.errorCount += 1;
    }
    const latency = Date.now() - (sample.startTime ?? Date.now());
    bucket.totalLatencyMs += latency;
    bucket.lastRequestAt = Date.now();

    if (options?.usage) {
      const usage = options.usage;
      bucket.totalPromptTokens += usage.prompt_tokens ?? 0;
      bucket.totalCompletionTokens += usage.completion_tokens ?? 0;
      bucket.totalOutputTokens += usage.total_tokens ?? 0;
    }
  }

  recordToolUsage(
    meta: { providerKey?: string; model?: string },
    payload: unknown
  ): void {
    const providerKey =
      typeof meta.providerKey === 'string' && meta.providerKey.trim() ? meta.providerKey.trim() : '';
    if (!providerKey) {
      return;
    }
    const toolCalls = this.extractToolCalls(payload);
    if (!toolCalls.length) {
      return;
    }
    const now = Date.now();
    this.totalToolCalls += toolCalls.length;
    this.totalToolResponses += 1;

    const providerBucketKey = this.composeBucketKey(providerKey, meta.model);
    const providerTotals = this.toolProviderTotals.get(providerBucketKey) ?? {
      providerKey,
      model: meta.model,
      totalCalls: 0,
      totalResponses: 0
    };
    providerTotals.totalCalls += toolCalls.length;
    providerTotals.totalResponses += 1;
    this.toolProviderTotals.set(providerBucketKey, providerTotals);

    const providerTools =
      this.toolBucketsByProvider.get(providerBucketKey) ?? new Map<string, ToolStatsBucket>();
    this.toolBucketsByProvider.set(providerBucketKey, providerTools);

    const uniqueNames = new Set<string>();
    for (const tool of toolCalls) {
      const name = tool.name;
      if (!name) {
        continue;
      }
      uniqueNames.add(name);
      const globalBucket = this.toolBuckets.get(name) ?? {
        toolName: name,
        callCount: 0,
        responseCount: 0,
        firstSeenAt: now,
        lastSeenAt: now
      };
      globalBucket.callCount += 1;
      globalBucket.lastSeenAt = now;
      this.toolBuckets.set(name, globalBucket);

      const providerBucket = providerTools.get(name) ?? {
        toolName: name,
        callCount: 0,
        responseCount: 0,
        firstSeenAt: now,
        lastSeenAt: now
      };
      providerBucket.callCount += 1;
      providerBucket.lastSeenAt = now;
      providerTools.set(name, providerBucket);
    }

    for (const name of uniqueNames) {
      const globalBucket = this.toolBuckets.get(name);
      if (globalBucket) {
        globalBucket.responseCount += 1;
        globalBucket.lastSeenAt = now;
      }
      const providerBucket = providerTools.get(name);
      if (providerBucket) {
        providerBucket.responseCount += 1;
        providerBucket.lastSeenAt = now;
      }
    }
  }

  snapshot(uptimeMs: number): StatsSnapshot {
    const totals: ProviderStatsView[] = Array.from(this.buckets.values()).map(bucket => ({
      ...bucket,
      averageLatencyMs: bucket.requestCount ? bucket.totalLatencyMs / bucket.requestCount : 0,
      averagePromptTokens: bucket.requestCount ? bucket.totalPromptTokens / bucket.requestCount : 0,
      averageCompletionTokens: bucket.requestCount ? bucket.totalCompletionTokens / bucket.requestCount : 0,
      averageOutputTokens: bucket.requestCount ? bucket.totalOutputTokens / bucket.requestCount : 0
    }));
    const tools = this.snapshotTools();
    return {
      generatedAt: Date.now(),
      uptimeMs,
      totals,
      ...(tools ? { tools } : {})
    };
  }

  logSummary(uptimeMs: number): StatsSnapshot {
    this.ensureHistoricalLoaded();
    const snapshot = this.snapshot(uptimeMs);
    if (!snapshot.totals.length) {
      console.log('[Stats] No provider activity recorded');
      return snapshot;
    }
    console.log(
      '\n[Stats][session] Provider summary (uptime=%d ms · samples=%d)',
      Math.round(snapshot.uptimeMs),
      snapshot.totals.reduce((sum, bucket) => sum + bucket.requestCount, 0)
    );
    for (const bucket of snapshot.totals) {
      const label = this.formatProviderLabel(bucket.providerKey, bucket.model);
      const okCount = bucket.requestCount - bucket.errorCount;
      console.log(
        '  - %s | requests=%d (%d ok / %d err) | avgLatency=%s ms | avgTokens in/out/total=%s/%s/%s',
        label,
        bucket.requestCount,
        okCount,
        bucket.errorCount,
        bucket.averageLatencyMs.toFixed(1),
        bucket.averagePromptTokens.toFixed(1),
        bucket.averageCompletionTokens.toFixed(1),
        bucket.averageOutputTokens.toFixed(1)
      );
      console.log(
        '      totals tokens in/out/total=%s/%s/%s',
        bucket.totalPromptTokens,
        bucket.totalCompletionTokens,
        bucket.totalOutputTokens
      );
    }
    this.logToolSummary(snapshot.tools);
    this.mergeSnapshotIntoHistorical(snapshot);
    return snapshot;
  }

  async persistSnapshot(snapshot: StatsSnapshot, options?: StatsPersistOptions): Promise<void> {
    try {
      const logPath = this.normalizeLogPath(options?.logPath);
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      const record = {
        ...snapshot,
        reason: options?.reason ?? 'shutdown',
        pid: process.pid
      } satisfies StatsSnapshot & { reason: string; pid: number };
      await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf-8');
    } catch (error) {
      console.warn('[Stats] Failed to persist provider stats snapshot', error);
    }
  }

  /**
   * 打印历史 provider-stats 聚合（内存中实时维护，异常退出前也能看到历史）。
   */
  async logHistoricalSummary(options?: { logPath?: string }): Promise<void> {
    if (options?.logPath && options.logPath.trim()) {
      this.normalizeLogPath(options.logPath);
    } else {
      this.ensureHistoricalLoaded();
    }
    this.logHistoricalFromMemory();
  }

  snapshotHistorical(): HistoricalStatsSnapshot {
    this.ensureHistoricalLoaded();
    const totals: ProviderStatsView[] = Array.from(this.historicalBuckets.values()).map(bucket => ({
      ...bucket,
      averageLatencyMs: bucket.requestCount ? bucket.totalLatencyMs / bucket.requestCount : 0,
      averagePromptTokens: bucket.requestCount ? bucket.totalPromptTokens / bucket.requestCount : 0,
      averageCompletionTokens: bucket.requestCount ? bucket.totalCompletionTokens / bucket.requestCount : 0,
      averageOutputTokens: bucket.requestCount ? bucket.totalOutputTokens / bucket.requestCount : 0
    }));
    return {
      generatedAt: Date.now(),
      snapshotCount: this.historicalSnapshotCount,
      sampleCount: this.historicalSampleCount,
      totals
    };
  }

  private composeBucketKey(providerKey: string, model?: string): string {
    return `${providerKey}|${model ?? '-'}`;
  }

  private snapshotTools(): ToolStatsSnapshot | undefined {
    if (this.totalToolCalls <= 0 && this.totalToolResponses <= 0) {
      return undefined;
    }
    const byToolName: Record<string, ToolStatsBucket> = {};
    for (const [name, bucket] of this.toolBuckets.entries()) {
      byToolName[name] = { ...bucket };
    }
    const byProviderKey: ToolStatsSnapshot['byProviderKey'] = {};
    for (const [providerKey, providerTools] of this.toolBucketsByProvider.entries()) {
      const totals = this.toolProviderTotals.get(providerKey);
      const byTool: Record<string, ToolStatsBucket> = {};
      for (const [name, bucket] of providerTools.entries()) {
        byTool[name] = { ...bucket };
      }
      byProviderKey[providerKey] = {
        providerKey: totals?.providerKey ?? providerKey,
        model: totals?.model,
        totalCalls: totals?.totalCalls ?? 0,
        totalResponses: totals?.totalResponses ?? 0,
        byToolName: byTool
      };
    }
    return {
      totalCalls: this.totalToolCalls,
      totalResponses: this.totalToolResponses,
      byToolName,
      byProviderKey
    };
  }

  private logToolSummary(snapshot?: ToolStatsSnapshot): void {
    if (!snapshot || snapshot.totalCalls <= 0) {
      return;
    }
    console.log('\n[Stats] Tools:');
    console.log(
      '  total tool calls : %d (responses with tools=%d)',
      snapshot.totalCalls,
      snapshot.totalResponses
    );
    const sorted = Object.values(snapshot.byToolName)
      .sort((a, b) => b.callCount - a.callCount)
      .slice(0, 10);
    if (sorted.length) {
      console.log('  top tools:');
      for (const bucket of sorted) {
        console.log(
          '    %s → calls=%d responses=%d',
          bucket.toolName,
          bucket.callCount,
          bucket.responseCount
        );
      }
    }
    const providerEntries = Object.values(snapshot.byProviderKey ?? {});
    if (providerEntries.length) {
      console.log('  by provider:');
      const sortedProviders = providerEntries
        .slice()
        .sort((a, b) => b.totalCalls - a.totalCalls)
        .slice(0, 10);
      for (const provider of sortedProviders) {
        const label = this.formatProviderLabel(provider.providerKey, provider.model);
        console.log(
          '    %s → calls=%d responses=%d',
          label,
          provider.totalCalls,
          provider.totalResponses
        );
      }
    }
  }

  private logHistoricalToolSummary(
    toolAggregate: Map<string, ToolStatsBucket>,
    toolByProvider: Map<string, {
      providerKey: string;
      model?: string;
      totalCalls: number;
      totalResponses: number;
      byToolName: Map<string, ToolStatsBucket>;
    }>
  ): void {
    if (toolAggregate.size === 0) {
      return;
    }
    const totalCalls = Array.from(toolAggregate.values()).reduce((sum, bucket) => sum + bucket.callCount, 0);
    const totalResponses = Array.from(toolAggregate.values()).reduce((sum, bucket) => sum + bucket.responseCount, 0);
    console.log(
      '\n[Stats] Historical tools summary (total calls=%d, responses with tools=%d)',
      totalCalls,
      totalResponses
    );
    const sorted = Array.from(toolAggregate.values())
      .sort((a, b) => b.callCount - a.callCount)
      .slice(0, 10);
    if (sorted.length) {
      console.log('  top tools:');
      for (const bucket of sorted) {
        console.log(
          '    %s → calls=%d responses=%d',
          bucket.toolName,
          bucket.callCount,
          bucket.responseCount
        );
      }
    }
    if (toolByProvider.size) {
      console.log('  by provider:');
      const entries = Array.from(toolByProvider.entries()).sort((a, b) => a[0].localeCompare(b[0]));
      for (const [, bucket] of entries) {
        const label = this.formatProviderLabel(bucket.providerKey, bucket.model);
        console.log(
          '    %s → calls=%d responses=%d',
          label,
          bucket.totalCalls,
          bucket.totalResponses
        );
      }
    }
  }

  private mergeToolAggregate(
    toolAggregate: Map<string, ToolStatsBucket>,
    toolByProvider: Map<string, {
      providerKey: string;
      model?: string;
      totalCalls: number;
      totalResponses: number;
      byToolName: Map<string, ToolStatsBucket>;
    }>,
    tools: ToolStatsSnapshot
  ): void {
    for (const bucket of Object.values(tools.byToolName ?? {})) {
      if (!bucket || !bucket.toolName) {
        continue;
      }
      const existing = toolAggregate.get(bucket.toolName);
      if (!existing) {
        toolAggregate.set(bucket.toolName, { ...bucket });
      } else {
        existing.callCount += bucket.callCount;
        existing.responseCount += bucket.responseCount;
        if (bucket.firstSeenAt < existing.firstSeenAt) {
          existing.firstSeenAt = bucket.firstSeenAt;
        }
        if (bucket.lastSeenAt > existing.lastSeenAt) {
          existing.lastSeenAt = bucket.lastSeenAt;
        }
      }
    }

    for (const providerRecord of Object.values(tools.byProviderKey ?? {})) {
      if (!providerRecord || !providerRecord.providerKey) {
        continue;
      }
      const providerKey = providerRecord.providerKey;
      const bucketKey = this.composeBucketKey(providerKey, providerRecord.model);
      const entry =
        toolByProvider.get(bucketKey) ?? {
          providerKey,
          model: providerRecord.model,
          totalCalls: 0,
          totalResponses: 0,
          byToolName: new Map<string, ToolStatsBucket>()
        };
      entry.totalCalls += providerRecord.totalCalls ?? 0;
      entry.totalResponses += providerRecord.totalResponses ?? 0;
      for (const toolBucket of Object.values(providerRecord.byToolName ?? {})) {
        if (!toolBucket || !toolBucket.toolName) {
          continue;
        }
        const existing = entry.byToolName.get(toolBucket.toolName);
        if (!existing) {
          entry.byToolName.set(toolBucket.toolName, { ...toolBucket });
        } else {
          existing.callCount += toolBucket.callCount;
          existing.responseCount += toolBucket.responseCount;
          if (toolBucket.firstSeenAt < existing.firstSeenAt) {
            existing.firstSeenAt = toolBucket.firstSeenAt;
          }
          if (toolBucket.lastSeenAt > existing.lastSeenAt) {
            existing.lastSeenAt = toolBucket.lastSeenAt;
          }
        }
      }
      toolByProvider.set(bucketKey, entry);
    }
  }

  private extractToolCalls(payload: unknown): Array<{ name: string; id?: string }> {
    if (!payload || typeof payload !== 'object') {
      return [];
    }
    const record = payload as Record<string, unknown>;
    const calls: Array<{ name: string; id?: string }> = [];
    const seenIds = new Set<string>();

    const addCall = (nameRaw: unknown, idRaw?: unknown): void => {
      const name =
        typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim() : '';
      if (!name) {
        return;
      }
      const id =
        typeof idRaw === 'string' && idRaw.trim() ? idRaw.trim() : undefined;
      if (id && seenIds.has(id)) {
        return;
      }
      if (id) {
        seenIds.add(id);
      }
      calls.push({ name, ...(id ? { id } : {}) });
    };

    const toolCalls = (record.tool_calls ?? (record.required_action as any)?.submit_tool_outputs?.tool_calls) as
      | unknown
      | undefined;
    if (Array.isArray(toolCalls)) {
      for (const toolCall of toolCalls) {
        if (!toolCall || typeof toolCall !== 'object') {
          continue;
        }
        const toolRec = toolCall as Record<string, unknown>;
        const fn = toolRec.function as Record<string, unknown> | undefined;
        addCall(fn?.name ?? toolRec.name, toolRec.id ?? toolRec.call_id ?? toolRec.tool_call_id);
      }
    }

    const output = record.output;
    if (Array.isArray(output)) {
      for (const entry of output) {
        if (!entry || typeof entry !== 'object') {
          continue;
        }
        const node = entry as Record<string, unknown>;
        const type = typeof node.type === 'string' ? node.type.trim().toLowerCase() : '';
        if (type === 'function_call' || type === 'tool_call' || type === 'function') {
          addCall(node.name ?? node.tool_name ?? (node.function as any)?.name, node.call_id ?? node.id);
        }
        if (Array.isArray(node.content)) {
          for (const contentItem of node.content as unknown[]) {
            if (!contentItem || typeof contentItem !== 'object') {
              continue;
            }
            const contentNode = contentItem as Record<string, unknown>;
            const contentType =
              typeof contentNode.type === 'string' ? contentNode.type.trim().toLowerCase() : '';
            if (contentType === 'tool_call' || contentType === 'function_call') {
              addCall(
                contentNode.name ?? contentNode.tool_name ?? (contentNode.function as any)?.name,
                contentNode.call_id ?? contentNode.id
              );
            }
          }
        }
      }
    }

    const choices = record.choices;
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        if (!choice || typeof choice !== 'object') {
          continue;
        }
        const message = (choice as Record<string, unknown>).message;
        if (!message || typeof message !== 'object') {
          continue;
        }
        const toolCallsNode = (message as Record<string, unknown>).tool_calls;
        if (Array.isArray(toolCallsNode)) {
          for (const toolCall of toolCallsNode) {
            if (!toolCall || typeof toolCall !== 'object') {
              continue;
            }
            const toolRec = toolCall as Record<string, unknown>;
            const fn = toolRec.function as Record<string, unknown> | undefined;
            addCall(fn?.name ?? toolRec.name, toolRec.id ?? toolRec.tool_call_id);
          }
        }
      }
    }

    return calls;
  }

  private mergeSnapshotIntoHistorical(snapshot?: StatsSnapshot | null): void {
    if (!snapshot) {
      return;
    }
    this.historicalSnapshotCount += 1;
    const totals = Array.isArray(snapshot.totals) ? snapshot.totals : [];
    let snapshotSamples = 0;
    for (const bucket of totals) {
      const key = this.composeBucketKey(bucket.providerKey, bucket.model);
      const existing = this.historicalBuckets.get(key);
      const promptTokens = bucket.totalPromptTokens ?? 0;
      const completionTokens = bucket.totalCompletionTokens ?? 0;
      const outputTokens = bucket.totalOutputTokens ?? 0;
      const latency = bucket.totalLatencyMs ?? 0;
      const firstAt = typeof bucket.firstRequestAt === 'number' ? bucket.firstRequestAt : Date.now();
      const lastAt = typeof bucket.lastRequestAt === 'number' ? bucket.lastRequestAt : Date.now();
      if (!existing) {
        this.historicalBuckets.set(key, {
          providerKey: bucket.providerKey,
          providerType: bucket.providerType,
          model: bucket.model,
          requestCount: bucket.requestCount ?? 0,
          errorCount: bucket.errorCount ?? 0,
          totalLatencyMs: latency,
          totalPromptTokens: promptTokens,
          totalCompletionTokens: completionTokens,
          totalOutputTokens: outputTokens,
          firstRequestAt: firstAt,
          lastRequestAt: lastAt
        });
      } else {
        existing.requestCount += bucket.requestCount ?? 0;
        existing.errorCount += bucket.errorCount ?? 0;
        existing.totalLatencyMs += latency;
        existing.totalPromptTokens += promptTokens;
        existing.totalCompletionTokens += completionTokens;
        existing.totalOutputTokens += outputTokens;
        if (firstAt < existing.firstRequestAt) {
          existing.firstRequestAt = firstAt;
        }
        if (lastAt > existing.lastRequestAt) {
          existing.lastRequestAt = lastAt;
        }
      }
      snapshotSamples += bucket.requestCount ?? 0;
    }
    this.historicalSampleCount += snapshotSamples;
    if (snapshot.tools && typeof snapshot.tools === 'object') {
      this.mergeToolAggregate(this.historicalToolAggregate, this.historicalToolByProvider, snapshot.tools);
    }
  }

  private logHistoricalFromMemory(): void {
    if (!this.historicalBuckets.size) {
      console.log('[Stats] No historical provider activity recorded');
      return;
    }
    console.log(
      '\n[Stats][historical] Provider summary (snapshots=%d · samples=%d)',
      this.historicalSnapshotCount,
      this.historicalSampleCount
    );
    const sorted = Array.from(this.historicalBuckets.values()).sort((a, b) =>
      a.providerKey.localeCompare(b.providerKey)
    );
    for (const bucket of sorted) {
      const label = this.formatProviderLabel(bucket.providerKey, bucket.model);
      const okCount = bucket.requestCount - bucket.errorCount;
      const avgLatency = bucket.requestCount ? bucket.totalLatencyMs / bucket.requestCount : 0;
      const avgPrompt = bucket.requestCount ? bucket.totalPromptTokens / bucket.requestCount : 0;
      const avgCompletion = bucket.requestCount ? bucket.totalCompletionTokens / bucket.requestCount : 0;
      const avgTotal = bucket.requestCount ? bucket.totalOutputTokens / bucket.requestCount : 0;
      console.log(
        '  - %s | requests=%d (%d ok / %d err) | avgLatency=%s ms | avgTokens in/out/total=%s/%s/%s',
        label,
        bucket.requestCount,
        okCount,
        bucket.errorCount,
        avgLatency.toFixed(1),
        avgPrompt.toFixed(1),
        avgCompletion.toFixed(1),
        avgTotal.toFixed(1)
      );
      console.log(
        '      totals tokens in/out/total=%s/%s/%s | window=%s → %s',
        bucket.totalPromptTokens,
        bucket.totalCompletionTokens,
        bucket.totalOutputTokens,
        this.formatIso(bucket.firstRequestAt),
        this.formatIso(bucket.lastRequestAt)
      );
    }
    this.logHistoricalToolSummary(this.historicalToolAggregate, this.historicalToolByProvider);
  }

  private ensureHistoricalLoaded(): void {
    if (this.historicalLoaded) {
      return;
    }
    this.loadHistoricalFromDisk(this.statsLogPath, true);
  }

  private loadHistoricalFromDisk(logPath: string, reset: boolean): void {
    if (reset) {
      this.historicalBuckets.clear();
      this.historicalToolAggregate.clear();
      this.historicalToolByProvider.clear();
      this.historicalSnapshotCount = 0;
      this.historicalSampleCount = 0;
    }
    try {
      const raw = fsSync.readFileSync(logPath, 'utf-8');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as StatsSnapshot & { reason?: string; pid?: number };
          this.mergeSnapshotIntoHistorical(record);
        } catch {
          continue;
        }
      }
    } catch {
      // File missing or unreadable → treat as empty history.
    }
    this.historicalLoaded = true;
  }

  private normalizeLogPath(override?: string): string {
    if (override && override.trim()) {
      const normalized = override.trim();
      if (normalized !== this.statsLogPath) {
        this.statsLogPath = normalized;
        this.historicalLoaded = false;
        this.loadHistoricalFromDisk(this.statsLogPath, true);
      }
      return normalized;
    }
    return this.statsLogPath;
  }

  private formatProviderLabel(providerKey?: string, model?: string): string {
    const key = typeof providerKey === 'string' && providerKey.trim() ? providerKey.trim() : '-';
    const modelId = typeof model === 'string' && model.trim() ? model.trim() : undefined;
    if (modelId) {
      return `${key} / ${modelId}`;
    }
    return key;
  }

  private formatIso(value?: number): string {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return '-';
    }
    try {
      return new Date(value).toISOString();
    } catch {
      return '-';
    }
  }

  private resolveLogPath(explicit?: string): string {
    if (explicit && explicit.trim()) {
      return explicit.trim();
    }
    const envPath = process.env.ROUTECODEX_STATS_LOG || process.env.RCC_STATS_LOG;
    if (envPath && envPath.trim()) {
      return envPath.trim();
    }
    return DEFAULT_STATS_LOG_PATH;
  }
}

export type UsageMetrics = UsageShape;
