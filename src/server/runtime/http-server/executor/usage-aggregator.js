/**
 * Usage Aggregator for request-executor
 *
 * Handles token usage extraction, normalization, and merging.
 */
import { formatUnknownError } from '../../../../utils/common-utils.js';
import { readRuntimeControlProjection } from '../metadata-center/request-truth-readers.js';
const NON_BLOCKING_LOG_THROTTLE_MS = 60_000;
const nonBlockingLogState = new Map();
function extractUsageCandidatesFromSseText(text) {
    const completed = [];
    const other = [];
    let currentEvent = '';
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        if (line.startsWith('event:')) {
            currentEvent = line.slice('event:'.length).trim();
            continue;
        }
        if (!line.startsWith('data:')) {
            continue;
        }
        const dataText = line.slice('data:'.length).trim();
        if (!dataText || dataText === '[DONE]') {
            continue;
        }
        try {
            const data = JSON.parse(dataText);
            const response = data.response && typeof data.response === 'object' && !Array.isArray(data.response)
                ? data.response
                : undefined;
            const message = data.message && typeof data.message === 'object' && !Array.isArray(data.message)
                ? data.message
                : undefined;
            const usage = response?.usage ?? data.usage ?? message?.usage;
            if (!usage) {
                continue;
            }
            const isTerminalUsage = currentEvent === 'response.completed'
                || data.type === 'response.completed'
                || currentEvent === 'message_delta'
                || data.type === 'message_delta';
            if (isTerminalUsage) {
                completed.push(usage);
            }
            else {
                other.push(usage);
            }
        }
        catch (error) {
            logUsageAggregatorNonBlockingError('extractUsageCandidatesFromSseText.parseDataLine', error, {
                lineLength: dataText.length
            });
        }
    }
    return [...completed, ...other];
}
function logUsageAggregatorNonBlockingError(stage, error, details) {
    const now = Date.now();
    const last = nonBlockingLogState.get(stage) ?? 0;
    if (now - last < NON_BLOCKING_LOG_THROTTLE_MS) {
        return;
    }
    nonBlockingLogState.set(stage, now);
    try {
        const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
        console.warn(`[usage-aggregator] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
    }
    catch {
        // Never throw from non-blocking logging.
    }
}
/**
 * Extract usage metrics from provider response
 */
export function extractUsageFromResult(result, metadata) {
    const runtimeControl = readRuntimeControlProjection(metadata);
    const sourceProtocol = typeof runtimeControl.providerProtocol === 'string'
        ? runtimeControl.providerProtocol.trim().toLowerCase()
        : typeof metadata?.providerProtocol === 'string'
            ? String(metadata.providerProtocol).trim().toLowerCase()
        : undefined;
    const candidates = [];
    if (result.body && typeof result.body === 'object') {
        const body = result.body;
        if (body.usage) {
            candidates.push(body.usage);
        }
        if (body.usageMetadata) {
            candidates.push(body.usageMetadata);
        }
        if (body.data && typeof body.data === 'object') {
            const bodyData = body.data;
            if (bodyData.usage) {
                candidates.push(bodyData.usage);
            }
            if (bodyData.usageMetadata) {
                candidates.push(bodyData.usageMetadata);
            }
        }
        if (body.response && typeof body.response === 'object') {
            const responseNode = body.response;
            if (responseNode.usage) {
                candidates.push(responseNode.usage);
            }
        }
        if (body.payload && typeof body.payload === 'object') {
            const payload = body.payload;
            if (payload.usage) {
                candidates.push(payload.usage);
            }
            if (payload.response && typeof payload.response === 'object') {
                const payloadResponse = payload.response;
                if (payloadResponse.usage) {
                    candidates.push(payloadResponse.usage);
                }
            }
        }
        if (typeof body.bodyText === 'string' && body.bodyText.trim()) {
            candidates.push(...extractUsageCandidatesFromSseText(body.bodyText));
        }
    }
    if (result.headers && typeof result.headers === 'object') {
        const usageHeader = (result.headers['x-usage'] || result.headers['X-Usage'] || result.headers['x-routecodex-usage']);
        if (typeof usageHeader === 'string' && usageHeader.trim()) {
            try {
                candidates.push(JSON.parse(usageHeader));
            }
            catch (error) {
                logUsageAggregatorNonBlockingError('extractUsageFromResult.parseUsageHeader', error, {
                    headerLength: usageHeader.length
                });
            }
        }
    }
    if (result.metadata && typeof result.metadata === 'object') {
        const resultMeta = result.metadata;
        if (resultMeta.usage) {
            candidates.push(resultMeta.usage);
        }
        if (resultMeta.usageMetadata) {
            candidates.push(resultMeta.usageMetadata);
        }
    }
    for (const candidate of candidates) {
        const normalized = normalizeUsage(candidate, {
            sourceProtocol
        });
        const hasNonZeroUsage = normalized
            && ((normalized.prompt_tokens ?? 0) > 0
                || (normalized.completion_tokens ?? 0) > 0
                || (normalized.total_tokens ?? 0) > 0
                || (normalized.cache_read_input_tokens ?? 0) > 0
                || (normalized.cache_creation_input_tokens ?? 0) > 0);
        if (hasNonZeroUsage) {
            return normalized;
        }
    }
    return undefined;
}
/**
 * Normalize usage metrics from various provider formats
 */
export function normalizeUsage(value, options) {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const record = value;
    const usageRecord = record.usageMetadata && typeof record.usageMetadata === 'object'
        ? record.usageMetadata
        : record;
    const readNumeric = (raw) => {
        if (typeof raw === 'number' && Number.isFinite(raw)) {
            return raw;
        }
        if (typeof raw === 'string' && raw.trim()) {
            const parsed = Number(raw);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
        return undefined;
    };
    // Detect source field to decide cache handling:
    // - prompt_tokens (OpenAI chat): already includes cache_read_input_tokens
    // - input_tokens (Anthropic): does NOT include cache_read_input_tokens
    // - input_tokens (OpenAI responses): already includes cached tokens (when protocol hint is known)
    const basePromptOpenAI = readNumeric(usageRecord.prompt_tokens);
    const basePromptAnthropic = readNumeric(usageRecord.input_tokens) ??
        readNumeric(usageRecord.inputTokens) ??
        readNumeric(usageRecord.request_tokens) ??
        readNumeric(usageRecord.requestTokens);
    const basePromptOther = readNumeric(usageRecord.promptTokenCount) ??
        readNumeric(usageRecord.promptTokens);
    let cacheRead = readNumeric(usageRecord.cache_read_input_tokens);
    if (cacheRead === undefined && usageRecord.input_tokens_details && typeof usageRecord.input_tokens_details === 'object') {
        const details = usageRecord.input_tokens_details;
        const cached = readNumeric(details.cached_tokens);
        if (cached !== undefined) {
            cacheRead = cached;
        }
    }
    if (cacheRead === undefined && usageRecord.prompt_tokens_details && typeof usageRecord.prompt_tokens_details === 'object') {
        const details = usageRecord.prompt_tokens_details;
        const cached = readNumeric(details.cached_tokens);
        if (cached !== undefined) {
            cacheRead = cached;
        }
    }
    // DeepSeek-style cache hit field
    if (cacheRead === undefined) {
        const deepseekCacheHit = readNumeric(usageRecord.prompt_cache_hit_tokens);
        if (deepseekCacheHit !== undefined) {
            cacheRead = deepseekCacheHit;
        }
    }
    const cacheCreation = readNumeric(usageRecord.cache_creation_input_tokens);
    const sourceProtocol = options?.sourceProtocol?.toLowerCase();
    const isResponsesProtocol = sourceProtocol === 'openai-responses';
    // prompt_tokens (OpenAI chat) already includes cache — do NOT add cacheRead again.
    // input_tokens (OpenAI responses) already includes cache — do NOT add cacheRead again.
    // input_tokens (Anthropic) does NOT include cache — add cacheRead.
    const prompt = basePromptOpenAI !== undefined
        ? basePromptOpenAI
        : isResponsesProtocol
            ? basePromptAnthropic
            : basePromptAnthropic !== undefined
                ? basePromptAnthropic + (cacheRead ?? 0)
                : basePromptOther;
    const completion = readNumeric(usageRecord.completion_tokens) ??
        readNumeric(usageRecord.output_tokens) ??
        readNumeric(usageRecord.candidatesTokenCount) ??
        readNumeric(usageRecord.completionTokens) ??
        readNumeric(usageRecord.outputTokens) ??
        readNumeric(usageRecord.response_tokens) ??
        readNumeric(usageRecord.responseTokens);
    let total = readNumeric(usageRecord.total_tokens) ??
        readNumeric(usageRecord.totalTokenCount) ??
        readNumeric(usageRecord.totalTokens);
    if (prompt !== undefined && completion !== undefined) {
        const expected = prompt + completion;
        if (total === undefined || total < expected) {
            total = expected;
        }
    }
    if (prompt === undefined && completion === undefined && total === undefined) {
        return undefined;
    }
    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: total,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation
    };
}
/**
 * Merge multiple usage metrics
 */
export function mergeUsageMetrics(base, delta) {
    if (!delta) {
        return base;
    }
    if (!base) {
        return { ...delta };
    }
    const merged = {
        prompt_tokens: (base.prompt_tokens ?? 0) + (delta.prompt_tokens ?? 0),
        completion_tokens: (base.completion_tokens ?? 0) + (delta.completion_tokens ?? 0)
    };
    const total = (base.total_tokens ?? 0) + (delta.total_tokens ?? 0);
    merged.total_tokens = total || undefined;
    const cacheRead = (base.cache_read_input_tokens ?? 0) + (delta.cache_read_input_tokens ?? 0);
    merged.cache_read_input_tokens = cacheRead || undefined;
    const cacheCreation = (base.cache_creation_input_tokens ?? 0) + (delta.cache_creation_input_tokens ?? 0);
    merged.cache_creation_input_tokens = cacheCreation || undefined;
    return merged;
}
/**
 * Build usage log text for logging
 */
export function computeCacheHitRatio(usage) {
    const inputTokens = usage?.prompt_tokens;
    const cacheRead = usage?.cache_read_input_tokens;
    if (cacheRead === undefined || cacheRead <= 0 || inputTokens === undefined || inputTokens <= 0) {
        return undefined;
    }
    return Math.min(1, cacheRead / inputTokens);
}
export function buildUsageLogText(usage) {
    const inputTokens = usage?.prompt_tokens;
    let outputTokens = usage?.completion_tokens;
    const total = usage?.total_tokens ??
        (inputTokens !== undefined && outputTokens !== undefined
            ? inputTokens + outputTokens
            : undefined);
    if (outputTokens === undefined && total !== undefined && inputTokens !== undefined) {
        outputTokens = Math.max(0, total - inputTokens);
    }
    const cacheRatio = computeCacheHitRatio(usage);
    const cacheSuffix = cacheRatio !== undefined
        ? ` cache=${(cacheRatio * 100).toFixed(1)}%`
        : '';
    return `input_tokens=${inputTokens ?? 'n/a'} output_tokens=${outputTokens ?? 'n/a'} total_tokens=${total ?? 'n/a'}${cacheSuffix}`;
}
