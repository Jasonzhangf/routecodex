import { getRouterHotpathJsonBindingSync } from '../../../modules/llmswitch/bridge/routing-state-store-host.js';
import { formatUnknownError } from '../../../utils/common-utils.js';

type RoutingInstructionState = Record<string, unknown>;
type NativeJsonBinding = Record<string, unknown>;

const NO_SESSION_DIR_OVERRIDE = '__ROUTECODEX_NO_SESSION_DIR_OVERRIDE__';

function buildRoutingStateFailure(stage: string, error: unknown, details?: Record<string, unknown>): Error {
  const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
  const wrapped = new Error(`[manager.routing] ${stage} failed: ${formatUnknownError(error)}${detailSuffix}`);
  Object.assign(wrapped, {
    code: 'ROUTING_STATE_STORE_FAILED',
    stage,
    details,
    cause: error
  });
  return wrapped;
}

function nativeJsonBinding(): NativeJsonBinding {
  return getRouterHotpathJsonBindingSync() as unknown as NativeJsonBinding;
}

function requireNativeJsonFunction<T extends (...args: never[]) => unknown>(capability: string): T {
  const fn = nativeJsonBinding()[capability];
  if (typeof fn !== 'function') {
    throw new Error(`${capability} native unavailable`);
  }
  return fn as T;
}

function normalizeSessionDirOverride(sessionDir?: string): string {
  if (typeof sessionDir !== 'string') {
    return NO_SESSION_DIR_OVERRIDE;
  }
  const trimmed = sessionDir.trim();
  return trimmed || NO_SESSION_DIR_OVERRIDE;
}

function plainRoutingState(state: unknown): unknown {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return state;
  }
  const record = state as RoutingInstructionState;
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

function hydrateRoutingState(raw: unknown): unknown | null {
  if (raw === null) {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw;
  }
  const record = raw as RoutingInstructionState;
  const disabledKeys = new Map<string, Set<string | number>>();
  if (Array.isArray(record.disabledKeys)) {
    for (const entry of record.disabledKeys) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const item = entry as Record<string, unknown>;
      if (typeof item.provider !== 'string' || !Array.isArray(item.keys)) continue;
      disabledKeys.set(
        item.provider,
        new Set(item.keys.filter((key) => typeof key === 'string' || typeof key === 'number') as Array<string | number>),
      );
    }
  }
  const disabledModels = new Map<string, Set<string>>();
  if (Array.isArray(record.disabledModels)) {
    for (const entry of record.disabledModels) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const item = entry as Record<string, unknown>;
      if (typeof item.provider !== 'string' || !Array.isArray(item.models)) continue;
      disabledModels.set(
        item.provider,
        new Set(item.models.filter((model) => typeof model === 'string') as string[]),
      );
    }
  }
  return {
    ...record,
    allowedProviders: new Set((Array.isArray(record.allowedProviders) ? record.allowedProviders : []).filter((value) => typeof value === 'string') as string[]),
    disabledProviders: new Set((Array.isArray(record.disabledProviders) ? record.disabledProviders : []).filter((value) => typeof value === 'string') as string[]),
    disabledKeys,
    disabledModels,
  };
}

function serializeRoutingStateForNative(state: unknown | null): string {
  if (state === null) return JSON.stringify(null);
  const serialize = requireNativeJsonFunction<(inputJson: string) => string>('serializeRoutingInstructionStateJson');
  return serialize(JSON.stringify(plainRoutingState(state)));
}

function deserializeRoutingStateFromNative(raw: string): unknown | null {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null) return null;
  const deserialize = requireNativeJsonFunction<(inputJson: string) => string>('deserializeRoutingInstructionStateJson');
  return hydrateRoutingState(JSON.parse(deserialize(JSON.stringify(parsed))));
}

export function loadRoutingInstructionStateSync(key: string): unknown | null {
  try {
    const fn = requireNativeJsonFunction<(key: string, sessionDir?: string) => string>('loadRoutingInstructionStateJson');
    const raw = fn(key, normalizeSessionDirOverride());
    return deserializeRoutingStateFromNative(raw);
  } catch (error) {
    throw buildRoutingStateFailure('routing_state_store.load_state.invoke', error, { key });
  }
}

export function saveRoutingInstructionStateAsync(key: string, state: unknown | null): void {
  saveRoutingInstructionStateSync(key, state);
}

export function saveRoutingInstructionStateSync(key: string, state: unknown | null): void {
  try {
    const fn = requireNativeJsonFunction<(key: string, stateJson: string, sessionDir?: string) => string | void>('saveRoutingInstructionStateJson');
    fn(key, serializeRoutingStateForNative(state), normalizeSessionDirOverride());
  } catch (error) {
    throw buildRoutingStateFailure('routing_state_store.save_sync.invoke', error, { key });
  }
}
