/**
 * State Integrations Bridge
 *
 * Routing state and session identifier compatibility wrappers.
 */
import { getRouterHotpathJsonBindingSync } from './native-exports.js';
import { formatUnknownError } from '../../../utils/common-utils.js';
const NO_SESSION_DIR_OVERRIDE = '__ROUTECODEX_NO_SESSION_DIR_OVERRIDE__';
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
function nativeJsonBinding() {
    return getRouterHotpathJsonBindingSync();
}
function requireNativeJsonFunction(capability) {
    const fn = nativeJsonBinding()[capability];
    if (typeof fn !== 'function') {
        throw new Error(`${capability} native unavailable`);
    }
    return fn;
}
function normalizeSessionDirOverride(sessionDir) {
    if (typeof sessionDir !== 'string') {
        return NO_SESSION_DIR_OVERRIDE;
    }
    const trimmed = sessionDir.trim();
    return trimmed || NO_SESSION_DIR_OVERRIDE;
}
function plainRoutingState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
        return state;
    }
    const record = state;
    return {
        ...record,
        allowedProviders: Array.from(record.allowedProviders instanceof Set ? record.allowedProviders : []),
        disabledProviders: Array.from(record.disabledProviders instanceof Set ? record.disabledProviders : []),
        disabledKeys: Array.from(record.disabledKeys instanceof Map ? record.disabledKeys : new Map()).map(([provider, keys]) => ({
            provider,
            keys: Array.from(keys instanceof Set ? keys : []),
        })),
        disabledModels: Array.from(record.disabledModels instanceof Map ? record.disabledModels : new Map()).map(([provider, models]) => ({
            provider,
            models: Array.from(models instanceof Set ? models : []),
        })),
    };
}
function hydrateRoutingState(raw) {
    if (raw === null)
        return null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return raw;
    }
    const record = raw;
    const disabledKeys = new Map();
    if (Array.isArray(record.disabledKeys)) {
        for (const entry of record.disabledKeys) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry))
                continue;
            const item = entry;
            if (typeof item.provider !== 'string' || !Array.isArray(item.keys))
                continue;
            disabledKeys.set(item.provider, new Set(item.keys.filter((key) => typeof key === 'string' || typeof key === 'number')));
        }
    }
    const disabledModels = new Map();
    if (Array.isArray(record.disabledModels)) {
        for (const entry of record.disabledModels) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry))
                continue;
            const item = entry;
            if (typeof item.provider !== 'string' || !Array.isArray(item.models))
                continue;
            disabledModels.set(item.provider, new Set(item.models.filter((model) => typeof model === 'string')));
        }
    }
    return {
        ...record,
        allowedProviders: new Set((Array.isArray(record.allowedProviders) ? record.allowedProviders : []).filter((value) => typeof value === 'string')),
        disabledProviders: new Set((Array.isArray(record.disabledProviders) ? record.disabledProviders : []).filter((value) => typeof value === 'string')),
        disabledKeys,
        disabledModels,
    };
}
function serializeRoutingStateForNative(state) {
    if (state === null)
        return JSON.stringify(null);
    const serialize = requireNativeJsonFunction('serializeRoutingInstructionStateJson');
    return serialize(JSON.stringify(plainRoutingState(state)));
}
function deserializeRoutingStateFromNative(raw) {
    const parsed = JSON.parse(raw);
    if (parsed === null)
        return null;
    const deserialize = requireNativeJsonFunction('deserializeRoutingInstructionStateJson');
    return hydrateRoutingState(JSON.parse(deserialize(JSON.stringify(parsed))));
}
export function loadRoutingInstructionStateSync(key) {
    try {
        const fn = requireNativeJsonFunction('loadRoutingInstructionStateJson');
        const raw = fn(key, normalizeSessionDirOverride());
        return deserializeRoutingStateFromNative(raw);
    }
    catch (error) {
        throw buildStateIntegrationFailure('routing_state_store.load_state.invoke', error, { key });
    }
}
export function saveRoutingInstructionStateAsync(key, state) {
    saveRoutingInstructionStateSync(key, state);
}
export function saveRoutingInstructionStateSync(key, state) {
    try {
        const fn = requireNativeJsonFunction('saveRoutingInstructionStateJson');
        fn(key, serializeRoutingStateForNative(state), normalizeSessionDirOverride());
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
        void meta;
        return {};
    }
    catch (error) {
        throw buildStateIntegrationFailure('session_identifiers.extract_continuation.invoke', error);
    }
}
