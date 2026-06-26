import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { resolveRccLogsDir } from '../../../config/user-data-paths.js';
import { formatUnknownError } from '../../../utils/common-utils.js';
import { buildSessionProviderRow, composeBucketKey, computeProviderTotals, extractToolCalls, formatProviderLabel, logHistoricalFromMemory, logProviderSummaryTable, logToolSummary, mergeSnapshotIntoHistorical, snapshotTools } from './stats-manager-internals.js';
const DEFAULT_STATS_LOG_PATH = path.join(resolveRccLogsDir(), 'provider-stats.jsonl');
const DEFAULT_HISTORY_MAX_TAIL_BYTES = 8 * 1024 * 1024;
const DEFAULT_HISTORY_MAX_LINES = 20000;
const DEFAULT_PERSIST_INTERVAL_MS = 30000;
const DEFAULT_STATS_LOG_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_STATS_LOG_MAX_BACKUPS = 3;
const DEFAULT_DAILY_PERIODS = 90;
const DEFAULT_WEEKLY_PERIODS = 104;
const DEFAULT_MONTHLY_PERIODS = 36;
const DEFAULT_INFLIGHT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_INFLIGHT_MAX_ENTRIES = 4096;
const NON_BLOCKING_LOG_THROTTLE_MS = 60_000;
const nonBlockingLogState = new Map();
function logStatsManagerNonBlockingError(stage, error, details) {
    const now = Date.now();
    const last = nonBlockingLogState.get(stage) ?? 0;
    if (now - last < NON_BLOCKING_LOG_THROTTLE_MS) {
        return;
    }
    nonBlockingLogState.set(stage, now);
    try {
        const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
        console.warn(`[stats-manager] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
    }
    catch {
        // Never throw from non-blocking logging.
    }
}
function resolveBoolFromEnv(value, defaultValue) {
    if (!value) {
        return defaultValue;
    }
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }
    return defaultValue;
}
function isStatsEnabledByDefault() {
    return resolveBoolFromEnv(process.env.ROUTECODEX_STATS_ENABLED ?? process.env.RCC_STATS_ENABLED, true);
}
function isStatsVerboseEnabled(enabled) {
    return resolveBoolFromEnv(process.env.ROUTECODEX_STATS_VERBOSE ?? process.env.RCC_STATS_VERBOSE, enabled);
}
function resolvePositiveIntEnv(primary, secondary, fallback) {
    const values = [primary, secondary];
    for (const value of values) {
        const parsed = Number(String(value || '').trim());
        if (Number.isFinite(parsed) && parsed >= 1) {
            return Math.floor(parsed);
        }
    }
    return fallback;
}
function resolveInflightTtlMs() {
    return resolvePositiveIntEnv(process.env.ROUTECODEX_STATS_INFLIGHT_TTL_MS, process.env.RCC_STATS_INFLIGHT_TTL_MS, DEFAULT_INFLIGHT_TTL_MS);
}
function resolveInflightMaxEntries() {
    return resolvePositiveIntEnv(process.env.ROUTECODEX_STATS_INFLIGHT_MAX_ENTRIES, process.env.RCC_STATS_INFLIGHT_MAX_ENTRIES, DEFAULT_INFLIGHT_MAX_ENTRIES);
}
async function rotateStatsLogIfNeeded(logPath, maxBytes, maxBackups) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
        return;
    }
    if (!Number.isFinite(maxBackups) || maxBackups <= 0) {
        return;
    }
    try {
        const stat = await fs.stat(logPath);
        if (!Number.isFinite(stat.size) || stat.size < maxBytes) {
            return;
        }
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            return;
        }
        throw error;
    }
    for (let idx = maxBackups; idx >= 1; idx -= 1) {
        const source = idx === 1 ? logPath : `${logPath}.${idx - 1}`;
        const target = `${logPath}.${idx}`;
        try {
            await fs.rm(target, { force: true });
        }
        catch (error) {
            logStatsManagerNonBlockingError('rotateStatsLogIfNeeded.removeTarget', error, {
                source,
                target
            });
        }
        try {
            await fs.rename(source, target);
        }
        catch (error) {
            if (error?.code === 'ENOENT') {
                continue;
            }
            throw error;
        }
    }
}
function toUtcDayKey(ts) {
    const date = new Date(ts);
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
function toUtcMonthKey(ts) {
    const date = new Date(ts);
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}
function toUtcIsoWeekKey(ts) {
    const date = new Date(ts);
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
function sumSnapshotTotals(rows) {
    const totals = {
        requestCount: 0,
        errorCount: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalOutputTokens: 0
    };
    for (const row of rows) {
        totals.requestCount += row.requestCount ?? 0;
        totals.errorCount += row.errorCount ?? 0;
        totals.totalPromptTokens += row.totalPromptTokens ?? 0;
        totals.totalCompletionTokens += row.totalCompletionTokens ?? 0;
        totals.totalOutputTokens += row.totalOutputTokens ?? 0;
    }
    return totals;
}
function sortSummaryRows(rows) {
    return rows
        .slice()
        .sort((a, b) => {
        const requestDelta = (b.requestCount ?? 0) - (a.requestCount ?? 0);
        if (requestDelta !== 0) {
            return requestDelta;
        }
        const keyA = composeBucketKey(a.providerKey, a.model);
        const keyB = composeBucketKey(b.providerKey, b.model);
        return keyA.localeCompare(keyB);
    });
}
function upsertPeriodBucket(map, period, delta) {
    const current = map.get(period) ?? {
        requestCount: 0,
        errorCount: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalOutputTokens: 0
    };
    current.requestCount += delta.requestCount;
    current.errorCount += delta.errorCount;
    current.totalPromptTokens += delta.totalPromptTokens;
    current.totalCompletionTokens += delta.totalCompletionTokens;
    current.totalOutputTokens += delta.totalOutputTokens;
    map.set(period, current);
}
function trimPeriodMap(map, maxEntries) {
    if (map.size <= maxEntries) {
        return;
    }
    const keys = Array.from(map.keys()).sort((a, b) => a.localeCompare(b));
    while (map.size > maxEntries && keys.length) {
        const key = keys.shift();
        if (key) {
            map.delete(key);
        }
    }
}
function readTailLines(filePath, maxTailBytes, maxLines) {
    let text = '';
    const stat = fsSync.statSync(filePath);
    if (!Number.isFinite(stat.size) || stat.size <= 0) {
        return [];
    }
    if (stat.size <= maxTailBytes) {
        text = fsSync.readFileSync(filePath, 'utf-8');
    }
    else {
        const start = Math.max(0, stat.size - maxTailBytes);
        const fd = fsSync.openSync(filePath, 'r');
        try {
            const length = stat.size - start;
            const buffer = Buffer.alloc(length);
            const read = fsSync.readSync(fd, buffer, 0, length, start);
            text = buffer.toString('utf8', 0, read);
            const firstNl = text.indexOf('\n');
            if (firstNl >= 0) {
                text = text.slice(firstNl + 1);
            }
        }
        finally {
            fsSync.closeSync(fd);
        }
    }
    return text
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-maxLines);
}
export class StatsManager {
    inflight = new Map();
    buckets = new Map();
    toolBuckets = new Map();
    toolBucketsByProvider = new Map();
    toolProviderTotals = new Map();
    totalToolCalls = 0;
    totalToolResponses = 0;
    enabled;
    verboseLogging;
    statsLogPath;
    historicalBuckets = new Map();
    historicalToolAggregate = new Map();
    historicalToolByProvider = new Map();
    historicalSnapshotCount = 0;
    historicalSampleCount = 0;
    historicalLoaded = false;
    dailyPeriods = new Map();
    weeklyPeriods = new Map();
    monthlyPeriods = new Map();
    persistIntervalMs;
    statsLogMaxBytes;
    statsLogMaxBackups;
    maxDailyPeriods;
    maxWeeklyPeriods;
    maxMonthlyPeriods;
    inflightTtlMs;
    inflightMaxEntries;
    periodicPersistTimer = null;
    persistSeq = 0;
    lastPeriodicSignature = '';
    persistSessionId = `${process.pid}-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
    constructor() {
        this.enabled = isStatsEnabledByDefault();
        this.verboseLogging = isStatsVerboseEnabled(this.enabled);
        this.statsLogPath = this.resolveLogPath();
        this.persistIntervalMs = resolvePositiveIntEnv(process.env.ROUTECODEX_STATS_PERSIST_INTERVAL_MS, process.env.RCC_STATS_PERSIST_INTERVAL_MS, DEFAULT_PERSIST_INTERVAL_MS);
        this.statsLogMaxBytes = resolvePositiveIntEnv(process.env.ROUTECODEX_STATS_LOG_MAX_BYTES, process.env.RCC_STATS_LOG_MAX_BYTES, DEFAULT_STATS_LOG_MAX_BYTES);
        this.statsLogMaxBackups = resolvePositiveIntEnv(process.env.ROUTECODEX_STATS_LOG_MAX_BACKUPS, process.env.RCC_STATS_LOG_MAX_BACKUPS, DEFAULT_STATS_LOG_MAX_BACKUPS);
        this.maxDailyPeriods = resolvePositiveIntEnv(process.env.ROUTECODEX_STATS_DAILY_MAX_PERIODS, process.env.RCC_STATS_DAILY_MAX_PERIODS, DEFAULT_DAILY_PERIODS);
        this.maxWeeklyPeriods = resolvePositiveIntEnv(process.env.ROUTECODEX_STATS_WEEKLY_MAX_PERIODS, process.env.RCC_STATS_WEEKLY_MAX_PERIODS, DEFAULT_WEEKLY_PERIODS);
        this.maxMonthlyPeriods = resolvePositiveIntEnv(process.env.ROUTECODEX_STATS_MONTHLY_MAX_PERIODS, process.env.RCC_STATS_MONTHLY_MAX_PERIODS, DEFAULT_MONTHLY_PERIODS);
        this.inflightTtlMs = resolveInflightTtlMs();
        this.inflightMaxEntries = resolveInflightMaxEntries();
        if (this.enabled) {
            this.loadHistoricalFromDisk(this.statsLogPath, true);
            this.startPeriodicPersistence();
        }
    }
    pruneInflight(nowMs) {
        if (!this.enabled || this.inflight.size < 1) {
            return;
        }
        const ttlMs = this.inflightTtlMs;
        if (Number.isFinite(ttlMs) && ttlMs > 0) {
            for (const [requestId, sample] of this.inflight.entries()) {
                const startedAtMs = typeof sample.startTime === 'number' && Number.isFinite(sample.startTime)
                    ? sample.startTime
                    : nowMs;
                if (nowMs - startedAtMs >= ttlMs) {
                    this.inflight.delete(requestId);
                }
            }
        }
        const maxEntries = this.inflightMaxEntries;
        if (!Number.isFinite(maxEntries) || maxEntries < 1 || this.inflight.size <= maxEntries) {
            return;
        }
        const ordered = Array.from(this.inflight.entries())
            .sort((a, b) => {
            const aStartedAt = typeof a[1].startTime === 'number' && Number.isFinite(a[1].startTime) ? a[1].startTime : 0;
            const bStartedAt = typeof b[1].startTime === 'number' && Number.isFinite(b[1].startTime) ? b[1].startTime : 0;
            return aStartedAt - bStartedAt;
        });
        const removeCount = Math.max(0, ordered.length - maxEntries);
        for (let idx = 0; idx < removeCount; idx += 1) {
            this.inflight.delete(ordered[idx][0]);
        }
    }
    recordRequestStart(requestId) {
        if (!this.enabled || !requestId) {
            return;
        }
        const nowMs = Date.now();
        this.pruneInflight(nowMs);
        this.inflight.set(requestId, { startTime: nowMs });
        this.pruneInflight(nowMs);
    }
    bindProvider(requestId, meta) {
        if (!this.enabled || !requestId) {
            return;
        }
        const nowMs = Date.now();
        this.pruneInflight(nowMs);
        const sample = this.inflight.get(requestId);
        if (sample) {
            if (meta.providerKey) {
                sample.providerKey = meta.providerKey;
            }
            if (meta.providerType) {
                sample.providerType = meta.providerType;
            }
            if (meta.model) {
                sample.model = meta.model;
            }
            if (typeof meta.entryPort === 'number') {
                sample.entryPort = meta.entryPort;
            }
            return;
        }
        this.inflight.set(requestId, { startTime: Date.now(), ...meta });
        this.pruneInflight(nowMs);
    }
    recordCompletion(requestId, options) {
        if (!this.enabled || !requestId) {
            return;
        }
        this.pruneInflight(Date.now());
        const sample = this.inflight.get(requestId);
        this.inflight.delete(requestId);
        if (!sample?.providerKey) {
            return;
        }
        const key = composeBucketKey(sample.providerKey, sample.model, sample.entryPort);
        let bucket = this.buckets.get(key);
        if (!bucket) {
            const now = Date.now();
            bucket = {
                providerKey: sample.providerKey,
                providerType: sample.providerType,
                model: sample.model,
                entryPort: sample.entryPort,
                requestCount: 0,
                errorCount: 0,
                totalLatencyMs: 0,
                totalPromptTokens: 0,
                totalCompletionTokens: 0,
                totalOutputTokens: 0,
                firstRequestAt: sample.startTime ?? now,
                lastRequestAt: now
            };
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
            bucket.totalOutputTokens += usage.completion_tokens ?? 0;
        }
    }
    recordToolUsage(meta, payload) {
        if (!this.enabled) {
            return;
        }
        const providerKey = typeof meta.providerKey === 'string' && meta.providerKey.trim() ? meta.providerKey.trim() : '';
        if (!providerKey) {
            return;
        }
        const toolCalls = extractToolCalls(payload);
        if (!toolCalls.length) {
            return;
        }
        const now = Date.now();
        this.totalToolCalls += toolCalls.length;
        this.totalToolResponses += 1;
        const providerBucketKey = composeBucketKey(providerKey, meta.model);
        const providerTotals = this.toolProviderTotals.get(providerBucketKey) ?? {
            providerKey,
            model: meta.model,
            totalCalls: 0,
            totalResponses: 0
        };
        providerTotals.totalCalls += toolCalls.length;
        providerTotals.totalResponses += 1;
        this.toolProviderTotals.set(providerBucketKey, providerTotals);
        const providerTools = this.toolBucketsByProvider.get(providerBucketKey) ?? new Map();
        this.toolBucketsByProvider.set(providerBucketKey, providerTools);
        const uniqueNames = new Set();
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
    snapshot(uptimeMs) {
        if (!this.enabled) {
            return { generatedAt: Date.now(), uptimeMs, totals: [] };
        }
        const totals = computeProviderTotals(this.buckets);
        const tools = snapshotTools({
            totalToolCalls: this.totalToolCalls,
            totalToolResponses: this.totalToolResponses,
            toolBuckets: this.toolBuckets,
            toolBucketsByProvider: this.toolBucketsByProvider,
            toolProviderTotals: this.toolProviderTotals
        });
        return { generatedAt: Date.now(), uptimeMs, totals, ...(tools ? { tools } : {}) };
    }
    logSummary(uptimeMs) {
        const snapshot = this.snapshot(uptimeMs);
        if (!this.enabled) {
            return snapshot;
        }
        this.ensureHistoricalLoaded();
        this.mergeSnapshotIntoHistorical(snapshot);
        if (!this.verboseLogging) {
            return snapshot;
        }
        if (!snapshot.totals.length) {
            console.log('[Stats] No provider activity recorded');
            return snapshot;
        }
        console.log('\n[Stats][session] Provider summary (uptime=%d ms · samples=%d)', Math.round(snapshot.uptimeMs), snapshot.totals.reduce((sum, bucket) => sum + bucket.requestCount, 0));
        logProviderSummaryTable(snapshot.totals.map((bucket) => buildSessionProviderRow(bucket)), false);
        logToolSummary(snapshot.tools, formatProviderLabel);
        return snapshot;
    }
    logFinalSummary(uptimeMs) {
        const session = this.snapshot(uptimeMs);
        if (!this.enabled) {
            return { session, historical: this.snapshotHistorical() };
        }
        this.ensureHistoricalLoaded();
        this.mergeSnapshotIntoHistorical(session);
        const historical = this.snapshotHistorical();
        const sessionTotals = sumSnapshotTotals(session.totals);
        const historicalTotals = sumSnapshotTotals(historical.totals);
        const sessionRows = sortSummaryRows(session.totals);
        const historicalRows = sortSummaryRows(historical.totals);
        console.log('\n[Stats][final][session] calls=%d errors=%d tokens(prompt/completion/total)=%d/%d/%d uptimeMs=%d', sessionTotals.requestCount, sessionTotals.errorCount, sessionTotals.totalPromptTokens, sessionTotals.totalCompletionTokens, sessionTotals.totalOutputTokens, Math.round(session.uptimeMs));
        if (!sessionRows.length) {
            console.log('[Stats][final][session] providers: none');
        }
        else {
            console.log('[Stats][final][session] providers:');
            for (const row of sessionRows) {
                const providerLabel = formatProviderLabel(row.providerKey, row.model);
                console.log('  - %s calls=%d tokens=%d/%d/%d', providerLabel, row.requestCount, row.totalPromptTokens, row.totalCompletionTokens, row.totalOutputTokens);
            }
        }
        console.log('\n[Stats][final][historical] calls=%d errors=%d tokens(prompt/completion/total)=%d/%d/%d snapshots=%d samples=%d', historicalTotals.requestCount, historicalTotals.errorCount, historicalTotals.totalPromptTokens, historicalTotals.totalCompletionTokens, historicalTotals.totalOutputTokens, historical.snapshotCount, historical.sampleCount);
        if (!historicalRows.length) {
            console.log('[Stats][final][historical] providers: none');
        }
        else {
            console.log('[Stats][final][historical] providers:');
            for (const row of historicalRows) {
                const providerLabel = formatProviderLabel(row.providerKey, row.model);
                console.log('  - %s calls=%d tokens=%d/%d/%d', providerLabel, row.requestCount, row.totalPromptTokens, row.totalCompletionTokens, row.totalOutputTokens);
            }
        }
        return { session, historical };
    }
    async persistSnapshot(snapshot, options) {
        if (!this.enabled) {
            return;
        }
        try {
            const logPath = this.normalizeLogPath(options?.logPath);
            await fs.mkdir(path.dirname(logPath), { recursive: true });
            await rotateStatsLogIfNeeded(logPath, this.statsLogMaxBytes, this.statsLogMaxBackups);
            const record = {
                ...snapshot,
                reason: options?.reason ?? 'shutdown',
                pid: process.pid,
                sessionId: this.persistSessionId,
                snapshotSeq: ++this.persistSeq,
                persistedAt: Date.now()
            };
            await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf-8');
        }
        catch (error) {
            console.warn('[Stats] Failed to persist provider stats snapshot', error);
        }
    }
    async logHistoricalSummary(options) {
        if (!this.enabled || !this.verboseLogging) {
            return;
        }
        if (options?.logPath && options.logPath.trim()) {
            this.normalizeLogPath(options.logPath);
        }
        else {
            this.ensureHistoricalLoaded();
        }
        logHistoricalFromMemory({
            historicalBuckets: this.historicalBuckets,
            historicalSnapshotCount: this.historicalSnapshotCount,
            historicalSampleCount: this.historicalSampleCount,
            historicalToolAggregate: this.historicalToolAggregate,
            historicalToolByProvider: this.historicalToolByProvider
        });
    }
    snapshotHistorical() {
        if (!this.enabled) {
            return { generatedAt: Date.now(), snapshotCount: 0, sampleCount: 0, totals: [] };
        }
        this.ensureHistoricalLoaded();
        const totals = computeProviderTotals(this.historicalBuckets);
        return {
            generatedAt: Date.now(),
            snapshotCount: this.historicalSnapshotCount,
            sampleCount: this.historicalSampleCount,
            totals
        };
    }
    snapshotHistoricalPeriods() {
        if (!this.enabled) {
            return { generatedAt: Date.now(), daily: [], weekly: [], monthly: [] };
        }
        this.ensureHistoricalLoaded();
        const toRows = (map) => Array.from(map.entries())
            .sort((a, b) => b[0].localeCompare(a[0]))
            .map(([period, bucket]) => ({ period, ...bucket }));
        return {
            generatedAt: Date.now(),
            daily: toRows(this.dailyPeriods),
            weekly: toRows(this.weeklyPeriods),
            monthly: toRows(this.monthlyPeriods)
        };
    }
    ensureHistoricalLoaded() {
        if (!this.enabled || this.historicalLoaded) {
            return;
        }
        this.loadHistoricalFromDisk(this.statsLogPath, true);
    }
    startPeriodicPersistence() {
        if (!this.enabled || this.persistIntervalMs <= 0) {
            return;
        }
        this.periodicPersistTimer = setInterval(() => {
            void this.persistPeriodicSnapshot();
        }, this.persistIntervalMs);
        this.periodicPersistTimer.unref?.();
    }
    async persistPeriodicSnapshot() {
        try {
            const snapshot = this.snapshot(Math.round(process.uptime() * 1000));
            if (!snapshot.totals.length) {
                return;
            }
            const signature = this.buildSnapshotSignature(snapshot);
            if (signature === this.lastPeriodicSignature) {
                return;
            }
            await this.persistSnapshot(snapshot, { reason: 'periodic' });
            this.lastPeriodicSignature = signature;
        }
        catch (error) {
            logStatsManagerNonBlockingError('persistPeriodicSnapshot', error, {
                logPath: this.statsLogPath
            });
        }
    }
    buildSnapshotSignature(snapshot) {
        const totals = sumSnapshotTotals(snapshot.totals || []);
        const toolCalls = typeof snapshot.tools?.totalCalls === 'number' ? snapshot.tools.totalCalls : 0;
        const toolResponses = typeof snapshot.tools?.totalResponses === 'number' ? snapshot.tools.totalResponses : 0;
        return [
            totals.requestCount,
            totals.errorCount,
            totals.totalPromptTokens,
            totals.totalCompletionTokens,
            totals.totalOutputTokens,
            toolCalls,
            toolResponses
        ].join(':');
    }
    mergeSnapshotIntoPeriods(snapshot) {
        const generatedAt = typeof snapshot.generatedAt === 'number' && Number.isFinite(snapshot.generatedAt)
            ? snapshot.generatedAt
            : Date.now();
        const totals = Array.isArray(snapshot.totals) ? snapshot.totals : [];
        if (!totals.length) {
            return;
        }
        const delta = sumSnapshotTotals(totals);
        const day = toUtcDayKey(generatedAt);
        const week = toUtcIsoWeekKey(generatedAt);
        const month = toUtcMonthKey(generatedAt);
        upsertPeriodBucket(this.dailyPeriods, day, delta);
        upsertPeriodBucket(this.weeklyPeriods, week, delta);
        upsertPeriodBucket(this.monthlyPeriods, month, delta);
        trimPeriodMap(this.dailyPeriods, this.maxDailyPeriods);
        trimPeriodMap(this.weeklyPeriods, this.maxWeeklyPeriods);
        trimPeriodMap(this.monthlyPeriods, this.maxMonthlyPeriods);
    }
    mergeSnapshotIntoHistorical(snapshot) {
        const merged = mergeSnapshotIntoHistorical({
            snapshot,
            historicalBuckets: this.historicalBuckets,
            historicalToolAggregate: this.historicalToolAggregate,
            historicalToolByProvider: this.historicalToolByProvider,
            historicalSnapshotCount: this.historicalSnapshotCount,
            historicalSampleCount: this.historicalSampleCount
        });
        this.historicalSnapshotCount = merged.historicalSnapshotCount;
        this.historicalSampleCount = merged.historicalSampleCount;
        this.mergeSnapshotIntoPeriods(snapshot);
    }
    loadHistoricalFromDisk(logPath, reset) {
        if (reset) {
            this.historicalBuckets.clear();
            this.historicalToolAggregate.clear();
            this.historicalToolByProvider.clear();
            this.historicalSnapshotCount = 0;
            this.historicalSampleCount = 0;
            this.dailyPeriods.clear();
            this.weeklyPeriods.clear();
            this.monthlyPeriods.clear();
        }
        try {
            const maxTailBytes = resolvePositiveIntEnv(process.env.ROUTECODEX_STATS_HISTORY_MAX_TAIL_BYTES, process.env.RCC_STATS_HISTORY_MAX_TAIL_BYTES, DEFAULT_HISTORY_MAX_TAIL_BYTES);
            const maxLines = resolvePositiveIntEnv(process.env.ROUTECODEX_STATS_HISTORY_MAX_LINES, process.env.RCC_STATS_HISTORY_MAX_LINES, DEFAULT_HISTORY_MAX_LINES);
            const lines = readTailLines(logPath, maxTailBytes, maxLines);
            const latestBySession = new Map();
            const legacyRecords = [];
            for (const line of lines) {
                try {
                    const record = JSON.parse(line);
                    if (typeof record?.sessionId === 'string' &&
                        record.sessionId.trim() &&
                        typeof record?.snapshotSeq === 'number' &&
                        Number.isFinite(record.snapshotSeq)) {
                        const key = record.sessionId.trim();
                        const seq = Math.floor(record.snapshotSeq);
                        const existing = latestBySession.get(key);
                        if (!existing ||
                            seq > existing.snapshotSeq ||
                            (seq === existing.snapshotSeq &&
                                (typeof record.generatedAt === 'number' ? record.generatedAt : 0) >
                                    (typeof existing.generatedAt === 'number' ? existing.generatedAt : 0))) {
                            latestBySession.set(key, { ...record, snapshotSeq: seq });
                        }
                    }
                    else {
                        legacyRecords.push(record);
                    }
                }
                catch (error) {
                    logStatsManagerNonBlockingError('loadHistoricalFromDisk.parseLine', error, {
                        logPath,
                        lineLength: line.length
                    });
                    continue;
                }
            }
            const dedupedRecords = [
                ...legacyRecords,
                ...Array.from(latestBySession.values())
            ].sort((a, b) => (typeof a.generatedAt === 'number' ? a.generatedAt : 0) -
                (typeof b.generatedAt === 'number' ? b.generatedAt : 0));
            for (const record of dedupedRecords) {
                const merged = mergeSnapshotIntoHistorical({
                    snapshot: record,
                    historicalBuckets: this.historicalBuckets,
                    historicalToolAggregate: this.historicalToolAggregate,
                    historicalToolByProvider: this.historicalToolByProvider,
                    historicalSnapshotCount: this.historicalSnapshotCount,
                    historicalSampleCount: this.historicalSampleCount
                });
                this.historicalSnapshotCount = merged.historicalSnapshotCount;
                this.historicalSampleCount = merged.historicalSampleCount;
                this.mergeSnapshotIntoPeriods(record);
            }
        }
        catch (error) {
            logStatsManagerNonBlockingError('loadHistoricalFromDisk', error, { logPath });
        }
        this.historicalLoaded = true;
    }
    normalizeLogPath(override) {
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
    resolveLogPath(explicit) {
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
