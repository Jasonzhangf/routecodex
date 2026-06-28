import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveRccPath } from '../config/user-data-paths.js';
import { redactSensitiveData } from './sensitive-redaction.js';
const KB = 1024;
const MB = 1024 * KB;
const DEFAULT_MAX_SAMPLE_BYTES = 256 * KB;
const DEFAULT_RESPONSES_TOOL_HISTORY_MAX_SAMPLE_BYTES = 4 * MB;
const DEFAULT_MAX_FILES_PER_GROUP = 50;
const DEFAULT_MAX_BYTES_PER_GROUP = 128 * MB;
const DEFAULT_CLIENT_TOOL_MAX_SAMPLE_BYTES = 24 * KB;
const DEFAULT_CLIENT_TOOL_MAX_FILES = 50;
const DEFAULT_CLIENT_TOOL_MAX_BYTES = 12 * MB;
const DEFAULT_PRUNE_INTERVAL_MS = 2000;
const pruneState = new Map();
const ERRORSAMPLE_SKIP_HTTP_STATUSES = new Set([429, 502]);
const DEFAULT_ERRORSAMPLE_QUEUE_MAX_ITEMS = 32;
const DEFAULT_ERRORSAMPLE_QUEUE_MEMORY_BUDGET_BYTES = 8 * MB;
const ERRORSAMPLE_QUEUE = [];
let errorsampleQueueBytes = 0;
let errorsampleDrainScheduled = false;
let errorsampleDrainInFlight = false;
let errorsampleDroppedCount = 0;
let errorsampleLastDropLogAt = 0;
function resolveErrorsamplesRoot() {
    const envOverride = process.env.ROUTECODEX_ERRORSAMPLES_DIR ||
        process.env.RCC_ERRORSAMPLES_DIR ||
        process.env.ROUTECODEX_ERROR_SAMPLES_DIR;
    if (envOverride && String(envOverride).trim()) {
        return path.resolve(String(envOverride).trim());
    }
    return resolveRccPath('errorsamples');
}
function safeName(name) {
    return String(name || 'sample').replace(/[^\w.-]/g, '_');
}
function safeStamp() {
    const iso = new Date().toISOString();
    return iso.replace(/[-:]/g, '').replace('T', '-').replace('.', '-');
}
function parseEnvPositiveInt(keys, fallback, min = 1) {
    for (const key of keys) {
        const raw = process.env[key];
        if (raw == null || String(raw).trim() === '') {
            continue;
        }
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
            continue;
        }
        const value = Math.floor(parsed);
        if (value >= min) {
            return value;
        }
    }
    return fallback;
}
function parseEnvBool(keys, fallback = false) {
    for (const key of keys) {
        const raw = String(process.env[key] ?? '').trim().toLowerCase();
        if (!raw) {
            continue;
        }
        if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
            return true;
        }
        if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
            return false;
        }
    }
    return fallback;
}
function resolveErrorsampleQueueMaxItems() {
    return parseEnvPositiveInt(['ROUTECODEX_ERRORSAMPLE_QUEUE_MAX_ITEMS', 'RCC_ERRORSAMPLE_QUEUE_MAX_ITEMS'], DEFAULT_ERRORSAMPLE_QUEUE_MAX_ITEMS);
}
function resolveErrorsampleQueueMemoryBudgetBytes() {
    return parseEnvPositiveInt(['ROUTECODEX_ERRORSAMPLE_QUEUE_MEMORY_BUDGET_BYTES', 'RCC_ERRORSAMPLE_QUEUE_MEMORY_BUDGET_BYTES'], DEFAULT_ERRORSAMPLE_QUEUE_MEMORY_BUDGET_BYTES);
}
function resolveGroupBudget(group, kind) {
    const normalizedGroup = safeName(group || 'sample').toLowerCase();
    const normalizedKind = safeName(kind || 'sample').toLowerCase();
    const maxSampleBytes = parseEnvPositiveInt(['ROUTECODEX_ERRORSAMPLE_MAX_BYTES', 'RCC_ERRORSAMPLE_MAX_BYTES'], DEFAULT_MAX_SAMPLE_BYTES);
    const defaultMaxFiles = parseEnvPositiveInt(['ROUTECODEX_ERRORSAMPLE_MAX_FILES_PER_GROUP', 'RCC_ERRORSAMPLE_MAX_FILES_PER_GROUP'], DEFAULT_MAX_FILES_PER_GROUP);
    const defaultMaxBytes = parseEnvPositiveInt(['ROUTECODEX_ERRORSAMPLE_MAX_BYTES_PER_GROUP', 'RCC_ERRORSAMPLE_MAX_BYTES_PER_GROUP'], DEFAULT_MAX_BYTES_PER_GROUP);
    const pruneIntervalMs = parseEnvPositiveInt(['ROUTECODEX_ERRORSAMPLE_PRUNE_INTERVAL_MS', 'RCC_ERRORSAMPLE_PRUNE_INTERVAL_MS'], DEFAULT_PRUNE_INTERVAL_MS, 0);
    if (normalizedGroup === 'client-tool-error') {
        return {
            maxSampleBytes: parseEnvPositiveInt(['ROUTECODEX_ERRORSAMPLE_CLIENT_TOOL_MAX_SAMPLE_BYTES', 'RCC_ERRORSAMPLE_CLIENT_TOOL_MAX_SAMPLE_BYTES'], DEFAULT_CLIENT_TOOL_MAX_SAMPLE_BYTES),
            maxFiles: parseEnvPositiveInt(['ROUTECODEX_ERRORSAMPLE_CLIENT_TOOL_MAX_FILES', 'RCC_ERRORSAMPLE_CLIENT_TOOL_MAX_FILES'], DEFAULT_CLIENT_TOOL_MAX_FILES),
            maxBytes: parseEnvPositiveInt(['ROUTECODEX_ERRORSAMPLE_CLIENT_TOOL_MAX_BYTES', 'RCC_ERRORSAMPLE_CLIENT_TOOL_MAX_BYTES'], DEFAULT_CLIENT_TOOL_MAX_BYTES),
            pruneIntervalMs
        };
    }
    if (normalizedGroup === 'payload-contract-error'
        && normalizedKind === 'responses.inbound_tool_history_contract') {
        return {
            maxSampleBytes: parseEnvPositiveInt([
                'ROUTECODEX_ERRORSAMPLE_RESPONSES_TOOL_HISTORY_MAX_SAMPLE_BYTES',
                'RCC_ERRORSAMPLE_RESPONSES_TOOL_HISTORY_MAX_SAMPLE_BYTES'
            ], DEFAULT_RESPONSES_TOOL_HISTORY_MAX_SAMPLE_BYTES),
            maxFiles: defaultMaxFiles,
            maxBytes: defaultMaxBytes,
            pruneIntervalMs
        };
    }
    return {
        maxSampleBytes,
        maxFiles: defaultMaxFiles,
        maxBytes: defaultMaxBytes,
        pruneIntervalMs
    };
}
function shouldWriteFullErrorsamplePayload() {
    if (parseEnvBool(['ROUTECODEX_SNAPSHOT_FULL', 'RCC_SNAPSHOT_FULL'], false)) {
        return true;
    }
    return parseEnvBool(['ROUTECODEX_SNAPSHOT', 'RCC_SNAPSHOT'], false);
}
function serializePayloadForWrite(payload, maxSampleBytes) {
    if (shouldWriteFullErrorsamplePayload()) {
        try {
            return JSON.stringify(payload, null, 2);
        }
        catch {
            return JSON.stringify({
                truncated: true,
                reason: 'payload_unserializable',
                preview: String(payload)
            }, null, 2);
        }
    }
    const maxBytes = Math.max(1024, Math.floor(maxSampleBytes));
    let pretty = '';
    try {
        pretty = JSON.stringify(payload, null, 2);
    }
    catch {
        pretty = JSON.stringify({
            truncated: true,
            reason: 'payload_unserializable',
            preview: String(payload)
        }, null, 2);
    }
    if (Buffer.byteLength(pretty, 'utf8') <= maxBytes) {
        return pretty;
    }
    let compact = '';
    try {
        compact = JSON.stringify(payload);
    }
    catch {
        compact = '';
    }
    const originalBytes = Buffer.byteLength(compact || pretty, 'utf8');
    let previewChars = Math.max(512, Math.floor(maxBytes * 0.6));
    while (previewChars >= 256) {
        const candidate = JSON.stringify({
            truncated: true,
            reason: 'payload_too_large',
            maxBytes,
            originalBytes,
            preview: (compact || pretty).slice(0, previewChars)
        }, null, 2);
        if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
            return candidate;
        }
        previewChars = Math.floor(previewChars * 0.75);
    }
    return JSON.stringify({
        truncated: true,
        reason: 'payload_too_large',
        maxBytes,
        originalBytes
    }, null, 2);
}
async function collectGroupFiles(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }
        const full = path.join(dir, entry.name);
        try {
            const stat = await fs.stat(full);
            files.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs || 0 });
        }
        catch {
            // ignore race with concurrent deletion
        }
    }
    files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
    return files;
}
async function pruneGroupDirectoryNow(dir, budget) {
    if (budget.maxFiles <= 0 || budget.maxBytes <= 0) {
        return;
    }
    const files = await collectGroupFiles(dir);
    if (files.length <= 0) {
        return;
    }
    let totalBytes = files.reduce((sum, file) => sum + Math.max(0, file.size), 0);
    let fileCount = files.length;
    const toDelete = [];
    for (const file of files) {
        if (fileCount <= budget.maxFiles && totalBytes <= budget.maxBytes) {
            break;
        }
        toDelete.push(file.path);
        fileCount -= 1;
        totalBytes -= Math.max(0, file.size);
    }
    if (toDelete.length <= 0) {
        return;
    }
    await Promise.all(toDelete.map((filePath) => fs.rm(filePath, { force: true })));
}
async function maybePruneGroupDirectory(dir, budget, options) {
    const force = options?.force === true;
    const state = pruneState.get(dir) || { lastRunAt: 0, pending: null };
    if (state.pending) {
        await state.pending;
        return;
    }
    const now = Date.now();
    if (!force && budget.pruneIntervalMs > 0 && now - state.lastRunAt < budget.pruneIntervalMs) {
        return;
    }
    const pending = (async () => {
        await pruneGroupDirectoryNow(dir, budget);
        state.lastRunAt = Date.now();
    })().finally(() => {
        const latest = pruneState.get(dir);
        if (latest) {
            latest.pending = null;
            pruneState.set(dir, latest);
        }
    });
    state.pending = pending;
    pruneState.set(dir, state);
    await pending;
}
function isEnospc(error) {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const code = error.code;
    return typeof code === 'string' && code.toUpperCase() === 'ENOSPC';
}
function readNumericLike(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.floor(value);
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed)) {
            return Math.floor(parsed);
        }
    }
    return null;
}
function shouldSkipErrorsamplePayload(payload) {
    if (shouldWriteFullErrorsamplePayload()) {
        return false;
    }
    const queue = [payload];
    const seen = new WeakSet();
    let steps = 0;
    while (queue.length > 0 && steps < 400) {
        steps += 1;
        const current = queue.shift();
        if (!current || typeof current !== 'object') {
            continue;
        }
        if (seen.has(current)) {
            continue;
        }
        seen.add(current);
        const record = current;
        const errorRecord = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
            ? record.error
            : undefined;
        const candidates = [
            readNumericLike(record.status),
            readNumericLike(record.statusCode),
            readNumericLike(record.httpStatus),
            readNumericLike(record.code),
            readNumericLike(record.upstreamStatus),
            readNumericLike(record.upstreamCode),
            readNumericLike(errorRecord?.status),
            readNumericLike(errorRecord?.statusCode),
            readNumericLike(errorRecord?.code)
        ];
        if (candidates.some((value) => value !== null && ERRORSAMPLE_SKIP_HTTP_STATUSES.has(value))) {
            return true;
        }
        for (const child of Object.values(record)) {
            if (child && typeof child === 'object') {
                queue.push(child);
            }
        }
    }
    return false;
}
function flushErrorsampleDropLog(force = false) {
    if (errorsampleDroppedCount <= 0) {
        return;
    }
    const now = Date.now();
    if (!force && now - errorsampleLastDropLogAt < 10_000) {
        return;
    }
    const dropped = errorsampleDroppedCount;
    errorsampleDroppedCount = 0;
    errorsampleLastDropLogAt = now;
    console.warn(`[errorsamples] queue overflow: dropped ${dropped} old pending sample(s) ` +
        `(pending=${ERRORSAMPLE_QUEUE.length}, bytes=${errorsampleQueueBytes})`);
}
async function persistErrorsampleItem(item) {
    await fs.mkdir(item.dir, { recursive: true });
    try {
        await fs.writeFile(item.file, item.serialized, 'utf8');
    }
    catch (error) {
        if (!isEnospc(error)) {
            throw error;
        }
        await maybePruneGroupDirectory(item.dir, item.budget, { force: true });
        await fs.writeFile(item.file, item.serialized, 'utf8');
    }
    await maybePruneGroupDirectory(item.dir, item.budget);
}
async function drainErrorsampleQueue() {
    while (ERRORSAMPLE_QUEUE.length > 0) {
        const item = ERRORSAMPLE_QUEUE.shift();
        if (!item) {
            continue;
        }
        errorsampleQueueBytes = Math.max(0, errorsampleQueueBytes - Math.max(1, item.sizeBytes));
        try {
            await persistErrorsampleItem(item);
            item.resolve(item.file);
        }
        catch (error) {
            item.reject(error);
        }
    }
    flushErrorsampleDropLog();
}
function scheduleErrorsampleDrain() {
    if (errorsampleDrainScheduled || errorsampleDrainInFlight) {
        return;
    }
    errorsampleDrainScheduled = true;
    setImmediate(() => {
        errorsampleDrainScheduled = false;
        if (errorsampleDrainInFlight) {
            return;
        }
        errorsampleDrainInFlight = true;
        void drainErrorsampleQueue()
            .catch((error) => {
            const reason = error instanceof Error ? error.message : String(error);
            console.warn(`[errorsamples] queue drain failed (non-blocking): ${reason}`);
        })
            .finally(() => {
            errorsampleDrainInFlight = false;
            if (ERRORSAMPLE_QUEUE.length > 0) {
                scheduleErrorsampleDrain();
            }
            else {
                flushErrorsampleDropLog(true);
            }
        });
    });
}
function enqueueErrorsampleItem(item) {
    const queueMaxItems = resolveErrorsampleQueueMaxItems();
    const queueBudgetBytes = resolveErrorsampleQueueMemoryBudgetBytes();
    while (ERRORSAMPLE_QUEUE.length > 0
        && (ERRORSAMPLE_QUEUE.length >= queueMaxItems || errorsampleQueueBytes + item.sizeBytes > queueBudgetBytes)) {
        const dropped = ERRORSAMPLE_QUEUE.shift();
        if (!dropped) {
            break;
        }
        errorsampleQueueBytes = Math.max(0, errorsampleQueueBytes - Math.max(1, dropped.sizeBytes));
        errorsampleDroppedCount += 1;
        dropped.resolve(null);
    }
    ERRORSAMPLE_QUEUE.push(item);
    errorsampleQueueBytes += item.sizeBytes;
    scheduleErrorsampleDrain();
    return new Promise((resolve, reject) => {
        item.resolve = resolve;
        item.reject = reject;
    });
}
export async function writeErrorsampleJson(options) {
    if (shouldSkipErrorsamplePayload(options.payload)) {
        return null;
    }
    const root = resolveErrorsamplesRoot();
    const safeScope = options.scopeId ? safeName(options.scopeId) : '';
    const portSeg = typeof options.entryPort === 'number' && Number.isFinite(options.entryPort) && options.entryPort > 0
        ? `port-${Math.floor(options.entryPort)}`
        : '';
    const dirSegments = [root, safeName(options.group)];
    if (safeScope)
        dirSegments.push(safeScope);
    if (portSeg)
        dirSegments.push(portSeg);
    const dir = path.join(...dirSegments);
    const budget = resolveGroupBudget(options.group, options.kind);
    const file = path.join(dir, `${safeName(options.kind)}-${safeStamp()}-${Math.random().toString(16).slice(2)}.json`);
    const sanitizedPayload = redactSensitiveData(options.payload);
    const serialized = serializePayloadForWrite(sanitizedPayload, budget.maxSampleBytes);
    const sizeBytes = Math.max(1, Buffer.byteLength(serialized, 'utf8'));
    return enqueueErrorsampleItem({
        dir,
        file,
        serialized,
        budget,
        sizeBytes,
        resolve: () => undefined,
        reject: () => undefined
    });
}
export async function __flushErrorsampleQueueForTests() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (ERRORSAMPLE_QUEUE.length === 0
            && errorsampleQueueBytes === 0
            && !errorsampleDrainScheduled
            && !errorsampleDrainInFlight) {
            flushErrorsampleDropLog(true);
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('errorsample queue did not flush in time');
}
export function __resetErrorsampleQueueForTests() {
    while (ERRORSAMPLE_QUEUE.length > 0) {
        const item = ERRORSAMPLE_QUEUE.shift();
        item?.resolve(null);
    }
    errorsampleQueueBytes = 0;
    errorsampleDrainScheduled = false;
    errorsampleDrainInFlight = false;
    errorsampleDroppedCount = 0;
    errorsampleLastDropLogAt = 0;
}
