/**
 * State Integrations Bridge
 *
 * Routing state, session identifier extraction, stats center, and
 * clock task store compatibility wrappers.
 */
import { requireCoreDist } from './module-loader.js';
import { formatUnknownError } from '../../../utils/common-utils.js';
import { MetadataCenter } from '../../../server/runtime/http-server/metadata-center/metadata-center.js';
function buildStateIntegrationFailure(stage, error, details) {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    const message = `[llmswitch-bridge.state-integrations] ${stage} failed: ${formatUnknownError(error)}${detailSuffix}`;
    const wrapped = new Error(message);
    Object.assign(wrapped, {
        code: 'STATE_INTEGRATION_FAILED',
        stage,
        details,
        cause: error
    });
    return wrapped;
}
export function loadRoutingInstructionStateSync(key) {
    try {
        const mod = requireCoreDist('native/router-hotpath/native-virtual-router-routing-state');
        const fn = mod.loadRoutingInstructionStateSync;
        if (typeof fn !== 'function') {
            throw new Error('loadRoutingInstructionStateSync native unavailable');
        }
        return fn(key);
    }
    catch (error) {
        throw buildStateIntegrationFailure('routing_state_store.load_state.invoke', error, { key });
    }
}
export function saveRoutingInstructionStateAsync(key, state) {
    try {
        const mod = requireCoreDist('native/router-hotpath/native-virtual-router-routing-state');
        const fn = mod.saveRoutingInstructionStateAsync;
        if (typeof fn !== 'function') {
            throw new Error('saveRoutingInstructionStateAsync native unavailable');
        }
        fn(key, state);
    }
    catch (error) {
        throw buildStateIntegrationFailure('routing_state_store.save_async.invoke', error, { key });
    }
}
export function saveRoutingInstructionStateSync(key, state) {
    try {
        const mod = requireCoreDist('native/router-hotpath/native-virtual-router-routing-state');
        const fn = mod.saveRoutingInstructionStateSync;
        if (typeof fn !== 'function') {
            throw new Error('saveRoutingInstructionStateSync native unavailable');
        }
        fn(key, state);
    }
    catch (error) {
        throw buildStateIntegrationFailure('routing_state_store.save_sync.invoke', error, { key });
    }
}
function readNormalizedMetadataToken(source, keys) {
    if (!source || typeof source !== 'object') {
        return undefined;
    }
    for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed) {
                return trimmed;
            }
        }
    }
    return undefined;
}
export function extractSessionIdentifiersFromMetadata(meta) {
    try {
        const sessionId = readNormalizedMetadataToken(meta, [
            'sessionId',
            'session_id'
        ]);
        const conversationId = readNormalizedMetadataToken(meta, [
            'conversationId',
            'conversation_id'
        ]);
        return {
            ...(sessionId ? { sessionId } : {}),
            ...(conversationId ? { conversationId } : {})
        };
    }
    catch (error) {
        throw buildStateIntegrationFailure('session_identifiers.extract.invoke', error);
    }
}
export function extractContinuationContextSessionIdentifiersFromMetadata(meta) {
    try {
        const responsesRequestContext = MetadataCenter.read(meta)?.readContinuationContext().responsesRequestContext;
        if (!responsesRequestContext || typeof responsesRequestContext !== 'object') {
            return {};
        }
        const sessionId = readNormalizedMetadataToken(responsesRequestContext, ['sessionId', 'session_id']);
        const conversationId = readNormalizedMetadataToken(responsesRequestContext, ['conversationId', 'conversation_id']);
        return {
            ...(sessionId ? { sessionId } : {}),
            ...(conversationId ? { conversationId } : {})
        };
    }
    catch (error) {
        throw buildStateIntegrationFailure('session_identifiers.extract_continuation.invoke', error);
    }
}
let cachedStatsCenter = undefined;
export function getStatsCenterSafe() {
    if (cachedStatsCenter) {
        return cachedStatsCenter;
    }
    if (cachedStatsCenter === null) {
        throw buildStateIntegrationFailure('stats_center.load.cached_unavailable', 'stats center unavailable');
    }
    try {
        const mod = requireCoreDist('telemetry/stats-center');
        const fn = mod?.getStatsCenter;
        const center = typeof fn === 'function' ? fn() : null;
        if (center && typeof center.recordProviderUsage === 'function') {
            cachedStatsCenter = center;
            return center;
        }
        throw buildStateIntegrationFailure('stats_center.api_unavailable', 'getStatsCenter not available');
    }
    catch (error) {
        cachedStatsCenter = null;
        throw buildStateIntegrationFailure('stats_center.load', error);
    }
}
export function getLlmsStatsSnapshot() {
    try {
        const mod = requireCoreDist('telemetry/stats-center');
        const get = mod?.getStatsCenter;
        const center = typeof get === 'function' ? get() : null;
        const snap = center && typeof center === 'object' ? center.getSnapshot : null;
        if (typeof snap !== 'function') {
            throw buildStateIntegrationFailure('stats_center.snapshot.api_unavailable', 'getSnapshot not available');
        }
        return snap.call(center);
    }
    catch (error) {
        throw buildStateIntegrationFailure('stats_center.snapshot.invoke', error);
    }
}
