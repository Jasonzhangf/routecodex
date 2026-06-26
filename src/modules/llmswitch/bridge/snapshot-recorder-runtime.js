import { buildInfo } from '../../../build-info.js';
import { resolveLlmswitchCoreVersion } from '../../../utils/runtime-versions.js';
import { writeErrorsampleJson } from '../../../utils/errorsamples.js';
import { MAX_CLIENT_TOOL_ERROR_TRACE_ENTRIES, MAX_STAGE_TRACE_ENTRIES, MAX_STAGE_TRACE_PAYLOAD_CHARS } from './snapshot-recorder-types.js';
import { classifyRuntimeErrorSignalFromText } from './snapshot-recorder-tool-failures.js';
const DEFAULT_CLIENT_TOOL_ERROR_SAMPLE_WINDOW_MS = 30 * 60_000;
const clientToolErrorSampleWindow = new Map();
const truthy = new Set(['1', 'true', 'yes', 'on']);
let cachedTracePayloadCaptureEnabled = null;
export function resetSnapshotRecorderErrorsampleStateForTests() {
    clientToolErrorSampleWindow.clear();
    cachedTracePayloadCaptureEnabled = null;
}
function isTracePayloadCaptureEnabled() {
    if (cachedTracePayloadCaptureEnabled !== null) {
        return cachedTracePayloadCaptureEnabled;
    }
    const raw = String(process.env.ROUTECODEX_STAGE_TRACE_CAPTURE_PAYLOAD
        ?? process.env.RCC_STAGE_TRACE_CAPTURE_PAYLOAD
        ?? '').trim().toLowerCase();
    cachedTracePayloadCaptureEnabled = truthy.has(raw);
    return cachedTracePayloadCaptureEnabled;
}
export function clipText(input, max = 320) {
    const text = String(input || '').trim();
    if (!text)
        return '';
    return text.length > max ? `${text.slice(0, max)}...` : text;
}
function getRecorderMetadata(context) {
    if (!context || typeof context !== 'object') {
        return {};
    }
    return {
        requestId: context.requestId,
        providerProtocol: context.providerProtocol,
        runtime: context.runtime
    };
}
export function writeBridgeErrorsample(args) {
    void writeErrorsampleJson({
        group: args.group,
        kind: args.kind,
        payload: {
            kind: args.sampleKind,
            timestamp: new Date().toISOString(),
            endpoint: args.endpoint,
            stage: args.stage,
            versions: {
                routecodex: buildInfo.version,
                llms: resolveLlmswitchCoreVersion(),
                node: process.version
            },
            ...getRecorderMetadata(args.context),
            ...(args.extras ?? {}),
            observation: args.observation
        }
    }).catch((error) => {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[snapshot-recorder] writeBridgeErrorsample failed group=${args.group} kind=${args.kind} stage=${args.stage}: ${reason}`);
    });
}
export function logClientToolError(args) {
    const req = args.requestId && args.requestId.trim().length ? args.requestId.trim() : 'unknown';
    const stage = args.stage && args.stage.trim().length ? args.stage.trim() : 'unknown';
    const tool = args.toolName && args.toolName.trim().length ? args.toolName.trim() : 'unknown';
    const errorType = args.errorType && args.errorType.trim().length ? args.errorType.trim() : 'unknown';
    const detail = clipText(args.matchedText || '', 240);
    const detailPart = detail ? ` detail=${detail}` : '';
    const condensedPart = args.condensed
        ? ' (more client-tool errors suppressed for this request; see ~/.rcc/errorsamples/client-tool-error/)'
        : '';
    console.error(`\x1b[31m[client-tool-error] requestId=${req} stage=${stage} tool=${tool} errorType=${errorType}${detailPart}${condensedPart}\x1b[0m`);
}
export function logRuntimeErrorSignal(args) {
    const req = args.requestId && args.requestId.trim().length ? args.requestId.trim() : 'unknown';
    const stage = args.stage && args.stage.trim().length ? args.stage.trim() : 'unknown';
    const detail = clipText(args.matchedText || '', 240);
    const detailPart = detail ? ` detail=${detail}` : '';
    console.error(`\x1b[31m[runtime-error] requestId=${req} group=${args.group} stage=${stage} errorType=${args.errorType}${detailPart}\x1b[0m`);
}
export function shouldLogRuntimeErrorSignalToConsole(signal) {
    return signal.group !== 'exec-error';
}
export function shouldInspectRuntimeError(stage, payload) {
    if (stage === 'chat_process.resp.stage1.sse_decode') {
        return true;
    }
    if (stage.startsWith('chat_process.req.') || stage.startsWith('chat_process.resp.')) {
        if (stage.includes('format_parse') ||
            stage.includes('semantic_map') ||
            stage.includes('format_build') ||
            stage.includes('tool_governance')) {
            return true;
        }
    }
    if (stage.includes('tool_governance')) {
        return true;
    }
    if (stage.startsWith('servertool.') || stage.startsWith('hub_followup.')) {
        return true;
    }
    return (typeof payload.error === 'string' ||
        typeof payload.message === 'string' ||
        typeof payload.reason === 'string');
}
function isLikelyContentPath(path) {
    return path.some((segment) => {
        if (typeof segment !== 'string') {
            return false;
        }
        return (segment === 'message' ||
            segment === 'content' ||
            segment === 'contents' ||
            segment === 'text' ||
            segment === 'messages' ||
            segment === 'tool_calls' ||
            segment === 'function' ||
            segment === 'arguments' ||
            segment === 'call_id' ||
            segment === 'input' ||
            segment === 'output' ||
            segment === 'reasoning' ||
            segment === 'summary' ||
            segment === 'excerpt' ||
            segment === 'observation');
    });
}
function shouldSkipSignalPath(path) {
    if (isLikelyContentPath(path)) {
        return true;
    }
    return path.some((segment) => typeof segment === 'string' && segment.startsWith('trace'));
}
function collectRuntimeSignalTexts(payload) {
    const candidates = [];
    const queue = [{ value: payload, path: [] }];
    const seen = new WeakSet();
    let steps = 0;
    while (queue.length > 0 && steps < 1200) {
        steps += 1;
        const current = queue.shift();
        if (!current) {
            continue;
        }
        const { value, path } = current;
        if (typeof value === 'string') {
            if (!shouldSkipSignalPath(path)) {
                candidates.push({ path, value });
            }
            continue;
        }
        if (!value || typeof value !== 'object') {
            continue;
        }
        if (seen.has(value)) {
            continue;
        }
        seen.add(value);
        if (Array.isArray(value)) {
            value.forEach((item, index) => {
                queue.push({ value: item, path: [...path, index] });
            });
            continue;
        }
        for (const [key, child] of Object.entries(value)) {
            if (key === 'error' ||
                key === 'message' ||
                key === 'reason' ||
                key === 'detail' ||
                key === 'details' ||
                key === 'statusText' ||
                key === 'failure' ||
                key === 'failureReason' ||
                key.endsWith('Error') ||
                key.endsWith('Reason') ||
                key.endsWith('Message') ||
                key.endsWith('Detail')) {
                queue.push({ value: child, path: [...path, key] });
            }
        }
    }
    return candidates;
}
export function classifyRuntimeErrorSignal(stage, payload) {
    if (stage === 'chat_process.resp.stage1.sse_decode') {
        const decoded = payload.decoded;
        const err = typeof payload.error === 'string' ? String(payload.error) : '';
        if (decoded === false && err) {
            return {
                group: 'parse-error',
                errorType: 'sse_decode_error',
                matchedText: err
            };
        }
    }
    const candidates = collectRuntimeSignalTexts(payload);
    if (candidates.length <= 0) {
        return null;
    }
    for (const candidate of candidates) {
        const resolved = classifyRuntimeErrorSignalFromText(stage, candidate.value);
        if (resolved) {
            return resolved;
        }
    }
    return null;
}
function cloneForErrorsample(value) {
    if (!isTracePayloadCaptureEnabled()) {
        return undefined;
    }
    try {
        const text = JSON.stringify(value);
        if (text.length <= MAX_STAGE_TRACE_PAYLOAD_CHARS) {
            return JSON.parse(text);
        }
        return {
            clipped: true,
            bytes: text.length,
            preview: text.slice(0, MAX_STAGE_TRACE_PAYLOAD_CHARS)
        };
    }
    catch {
        return { clipped: true, reason: 'serialize_failed' };
    }
}
export function appendStageTrace(trace, stage, payload) {
    const shouldCapturePayload = isTracePayloadCaptureEnabled();
    trace.push({
        at: new Date().toISOString(),
        stage,
        payload: shouldCapturePayload ? cloneForErrorsample(payload) : undefined
    });
    if (trace.length > MAX_STAGE_TRACE_ENTRIES) {
        trace.splice(0, trace.length - MAX_STAGE_TRACE_ENTRIES);
    }
}
export function cloneStageTraceSummary(trace, limit = MAX_CLIENT_TOOL_ERROR_TRACE_ENTRIES) {
    const tail = limit > 0 ? trace.slice(-limit) : trace;
    return tail.map((item) => ({
        at: item.at,
        stage: item.stage
    }));
}
function resolveClientToolErrorSampleWindowMs() {
    const raw = process.env.ROUTECODEX_CLIENT_TOOL_ERROR_SAMPLE_WINDOW_MS ||
        process.env.RCC_CLIENT_TOOL_ERROR_SAMPLE_WINDOW_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return DEFAULT_CLIENT_TOOL_ERROR_SAMPLE_WINDOW_MS;
    }
    return Math.floor(parsed);
}
export function isRecordableApplyPatchErrorType(errorType) {
    return true;
}
export function shouldWriteClientToolErrorsample(args) {
    if (args.failure.toolName === 'apply_patch' &&
        !isRecordableApplyPatchErrorType(args.failure.errorType)) {
        return false;
    }
    if (args.failure.toolName === 'exec_command' &&
        args.failure.errorType === 'exec_command_non_zero_exit' &&
        /\bcode 1\b/i.test(args.failure.matchedText || '')) {
        return false;
    }
    const windowMs = resolveClientToolErrorSampleWindowMs();
    if (windowMs <= 0) {
        return true;
    }
    const now = Date.now();
    const matchedFingerprint = args.failure.toolName === 'apply_patch'
        ? clipText(String(args.failure.matchedText || '').replace(/\s+/g, ' ').toLowerCase(), 120)
        : '';
    const key = [
        args.endpoint,
        args.stage,
        args.failure.toolName,
        args.failure.errorType,
        matchedFingerprint
    ].join('|');
    for (const [sampleKey, seenAt] of clientToolErrorSampleWindow.entries()) {
        if (now - seenAt > windowMs) {
            clientToolErrorSampleWindow.delete(sampleKey);
        }
    }
    const lastSeenAt = clientToolErrorSampleWindow.get(key);
    if (typeof lastSeenAt === 'number' && now - lastSeenAt <= windowMs) {
        return false;
    }
    clientToolErrorSampleWindow.set(key, now);
    return true;
}
export function summarizeClientToolObservation(payload, failures) {
    return {
        topLevelKeys: Object.keys(payload || {}).slice(0, 20),
        failureCount: failures.length,
        toolMessageCount: failures.length,
        failures: failures.slice(-4).map((failure) => ({
            toolName: failure.toolName,
            errorType: failure.errorType,
            toolCallId: failure.toolCallId,
            callId: failure.callId,
            matchedPreview: clipText(failure.matchedText, 180)
        })),
        toolMessages: failures.slice(-4).map((failure) => ({
            name: failure.toolName,
            tool_call_id: failure.toolCallId,
            call_id: failure.callId,
            contentPreview: clipText(failure.matchedText, 180)
        }))
    };
}
