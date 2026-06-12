import type { RouterMetadataInput } from './virtual-router-contracts.js';
import { failNativeRequired } from './native-router-hotpath-policy.js';
import {
  parseJson,
  parseRecord,
  parseString,
  readNativeFunction,
  safeStringify
} from './native-shared-conversion-semantics-core.js';

export const DEFAULT_STOP_MESSAGE_MAX_REPEATS = 10;

export interface StoplessGoalStateSnapshot {
  status: 'idle' | 'active' | 'paused' | 'stopped' | 'completed';
  objective: string;
  latestNote?: string;
  completionEvidence?: string;
  nextStep?: string;
  userQuestion?: string;
  cannotContinueReason?: string;
  blockingEvidence?: string;
  attemptsExhausted?: boolean;
  errorClass?: string;
  completionSummary?: string;
  ssotAssessment?: string;
  consecutiveIrrecoverableErrors?: number;
  consecutiveValidationFailures?: number;
  consecutiveNoProgress?: number;
  updatedAt: number;
  createdAt: number;
}

export interface RoutingInstruction {
  type:
    | 'force'
    | 'prefer'
    | 'disable'
    | 'enable'
    | 'clear'
    | 'allow'
    | 'stopMessageSet'
    | 'stopMessageMode'
    | 'stopMessageClear'
    | 'preCommandSet'
    | 'preCommandClear';
  provider?: string;
  keyAlias?: string;
  keyIndex?: number;
  model?: string;
  pathLength?: number;
  processMode?: 'chat';
  stopMessageText?: string;
  stopMessageMaxRepeats?: number;
  stopMessageStageMode?: 'on' | 'off' | 'auto';
  stopMessageAiMode?: 'on' | 'off';
  stopMessageSource?: string;
  fromHistoricalUserMessage?: boolean;
  preCommandScriptPath?: string;
}

export interface RoutingInstructionState {
  stoplessGoalState?: StoplessGoalStateSnapshot;
  forcedTarget?: {
    provider?: string;
    keyAlias?: string;
    keyIndex?: number;
    model?: string;
    pathLength?: number;
    processMode?: 'chat';
  };
  preferTarget?: {
    provider?: string;
    keyAlias?: string;
    keyIndex?: number;
    model?: string;
    pathLength?: number;
    processMode?: 'chat';
  };
  allowedProviders: Set<string>;
  disabledProviders: Set<string>;
  disabledKeys: Map<string, Set<string | number>>;
  disabledModels: Map<string, Set<string>>;
  stopMessageSource?: string;
  stopMessageText?: string;
  stopMessageProviderKey?: string;
  stopMessageMaxRepeats?: number;
  stopMessageUsed?: number;
  stopMessageUpdatedAt?: number;
  stopMessageLastUsedAt?: number;
  stopMessageStageMode?: 'on' | 'off' | 'auto';
  stopMessageAiMode?: 'on' | 'off';
  stopMessageAiSeedPrompt?: string;
  stopMessageAiHistory?: Array<Record<string, unknown>>;
  preCommandSource?: string;
  preCommandScriptPath?: string;
  preCommandUpdatedAt?: number;
  chatProcessLastTotalTokens?: number;
  chatProcessLastInputTokens?: number;
  chatProcessLastMessageCount?: number;
  chatProcessLastUpdatedAt?: number;
}

export type RoutingInstructionStateStoreLike = {
  loadSync: (key: string) => RoutingInstructionState | null;
  saveAsync: (key: string, state: RoutingInstructionState | null) => void;
  saveSync?: (key: string, state: RoutingInstructionState | null) => void;
};

export class RoutingStateKeyMissingError extends Error {
  constructor(public readonly key: string | undefined, message: string) {
    super(message);
    this.name = 'RoutingStateKeyMissingError';
  }
}

function invokeNativeString(capability: string, args: unknown[]): string {
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const result = fn(...args);
    if (typeof result !== 'string' || !result) {
      return fail('empty result');
    }
    return result;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error ?? 'unknown'));
  }
}

function stringifyForNative(capability: string, value: unknown): string {
  return safeStringify(value) ?? failNativeRequired<string>(capability, 'json stringify failed');
}

function parseRecordPayload(capability: string, raw: string): Record<string, unknown> {
  return parseRecord(raw) ?? failNativeRequired<Record<string, unknown>>(capability, 'invalid payload');
}

function plainState(state: RoutingInstructionState | Record<string, unknown>): Record<string, unknown> {
  const record = state as RoutingInstructionState;
  const out: Record<string, unknown> = {
    ...record,
    allowedProviders: Array.from(record.allowedProviders ?? []),
    disabledProviders: Array.from(record.disabledProviders ?? []),
    disabledKeys: Array.from(record.disabledKeys ?? new Map()).map(([provider, keys]) => ({
      provider,
      keys: Array.from(keys)
    })),
    disabledModels: Array.from(record.disabledModels ?? new Map()).map(([provider, models]) => ({
      provider,
      models: Array.from(models)
    }))
  };
  return out;
}

function hydrateState(raw: Record<string, unknown>): RoutingInstructionState {
  const disabledKeys = new Map<string, Set<string | number>>();
  if (Array.isArray(raw.disabledKeys)) {
    for (const entry of raw.disabledKeys) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.provider !== 'string' || !Array.isArray(record.keys)) continue;
      disabledKeys.set(record.provider, new Set(record.keys.filter((key) => typeof key === 'string' || typeof key === 'number') as Array<string | number>));
    }
  }
  const disabledModels = new Map<string, Set<string>>();
  if (Array.isArray(raw.disabledModels)) {
    for (const entry of raw.disabledModels) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.provider !== 'string' || !Array.isArray(record.models)) continue;
      disabledModels.set(record.provider, new Set(record.models.filter((model) => typeof model === 'string') as string[]));
    }
  }
  return {
    ...raw,
    allowedProviders: new Set((Array.isArray(raw.allowedProviders) ? raw.allowedProviders : []).filter((value) => typeof value === 'string') as string[]),
    disabledProviders: new Set((Array.isArray(raw.disabledProviders) ? raw.disabledProviders : []).filter((value) => typeof value === 'string') as string[]),
    disabledKeys,
    disabledModels
  } as RoutingInstructionState;
}

function isPersistentScopeKey(key: string | undefined): key is string {
  return Boolean(
    key &&
      (key.startsWith('session:') ||
        key.startsWith('conversation:') ||
        key.startsWith('tmux:'))
  );
}

function isRoutingStateEmpty(state: RoutingInstructionState): boolean {
  const stopText = typeof state.stopMessageText === 'string' ? state.stopMessageText.trim() : '';
  const preCommand = typeof state.preCommandScriptPath === 'string' ? state.preCommandScriptPath.trim() : '';
  return (
    !state.stoplessGoalState &&
    !state.forcedTarget &&
    !state.preferTarget &&
    state.allowedProviders.size === 0 &&
    state.disabledProviders.size === 0 &&
    state.disabledKeys.size === 0 &&
    state.disabledModels.size === 0 &&
    !stopText &&
    !(typeof state.stopMessageProviderKey === 'string' && state.stopMessageProviderKey.trim()) &&
    state.stopMessageMaxRepeats === undefined &&
    state.stopMessageUsed === undefined &&
    state.stopMessageStageMode === undefined &&
    state.stopMessageAiMode === undefined &&
    !preCommand &&
    state.preCommandUpdatedAt === undefined
  );
}

export function serializeRoutingInstructionState(state: RoutingInstructionState): Record<string, unknown> {
  const capability = 'serializeRoutingInstructionStateJson';
  const raw = invokeNativeString(capability, [stringifyForNative(capability, plainState(state))]);
  return parseRecordPayload(capability, raw);
}

export function deserializeRoutingInstructionState(data: Record<string, unknown>): RoutingInstructionState {
  const capability = 'deserializeRoutingInstructionStateJson';
  const raw = invokeNativeString(capability, [stringifyForNative(capability, data)]);
  return hydrateState(parseRecordPayload(capability, raw));
}

export function resolveRoutingStateKey(metadata: RouterMetadataInput | Record<string, unknown>): string {
  const capability = 'resolveVirtualRouterRoutingStateKeyJson';
  const raw = invokeNativeString(capability, [stringifyForNative(capability, metadata ?? null)]);
  return parseString(raw) ?? failNativeRequired<string>(capability, 'invalid payload');
}

export function resolveStopMessageScope(metadata: RouterMetadataInput | Record<string, unknown>): string | undefined {
  const capability = 'resolveVirtualRouterStopMessageScopeJson';
  const raw = invokeNativeString(capability, [stringifyForNative(capability, metadata ?? null)]);
  const parsed = parseJson(raw);
  if (parsed === null) return undefined;
  return typeof parsed === 'string' && parsed.trim()
    ? parsed.trim()
    : failNativeRequired<string | undefined>(capability, 'invalid payload');
}

export function loadRoutingInstructionStateSync(key: string | undefined): RoutingInstructionState | null {
  if (!isPersistentScopeKey(key)) {
    throw new RoutingStateKeyMissingError(key, 'Routing state key missing or invalid; failing fast per no-fallback policy');
  }
  const capability = 'loadRoutingInstructionStateJson';
  const raw = invokeNativeString(capability, [key, process.env.ROUTECODEX_SESSION_DIR]);
  const parsed = parseJson(raw);
  if (parsed === null) return null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failNativeRequired<RoutingInstructionState | null>(capability, 'invalid payload');
  }
  return hydrateState(parsed as Record<string, unknown>);
}

export function saveRoutingInstructionStateSync(key: string | undefined, state: RoutingInstructionState | null): void {
  if (!isPersistentScopeKey(key)) {
    return;
  }
  const capability = 'saveRoutingInstructionStateJson';
  const payload = state ? serializeRoutingInstructionState(state) : null;
  invokeNativeString(capability, [key, stringifyForNative(capability, payload), process.env.ROUTECODEX_SESSION_DIR]);
}

export function saveRoutingInstructionStateAsync(key: string | undefined, state: RoutingInstructionState | null): void {
  saveRoutingInstructionStateSync(key, state);
}

export function mergeStopMessageFromPersisted(
  existing: RoutingInstructionState | Record<string, unknown>,
  persisted: RoutingInstructionState | Record<string, unknown> | null
): RoutingInstructionState {
  const capability = 'mergeStopMessageFromPersistedJson';
  const raw = invokeNativeString(capability, [
    stringifyForNative(capability, plainState(existing as RoutingInstructionState)),
    stringifyForNative(capability, persisted ? plainState(persisted as RoutingInstructionState) : null)
  ]);
  return hydrateState(parseRecordPayload(capability, raw));
}

export function getRoutingInstructionState(
  routingStateKey: string | undefined,
  routingInstructionState: Map<string, RoutingInstructionState>,
  routingStateStore: RoutingInstructionStateStoreLike
): RoutingInstructionState {
  const key = routingStateKey || 'default';
  const existing = routingInstructionState.get(key);
  if (existing) {
    if (isPersistentScopeKey(key)) {
      const persisted = routingStateStore.loadSync(key);
      const merged = mergeStopMessageFromPersisted(existing, persisted);
      Object.assign(existing, merged);
      if (persisted) {
        existing.preCommandSource = persisted.preCommandSource;
        existing.preCommandScriptPath = persisted.preCommandScriptPath;
        existing.preCommandUpdatedAt = persisted.preCommandUpdatedAt;
      }
    }
    return existing;
  }
  const initial = isPersistentScopeKey(key) ? routingStateStore.loadSync(key) : null;
  const state = initial ?? hydrateState({});
  routingInstructionState.set(key, state);
  return state;
}

export function persistRoutingInstructionState(
  key: string,
  state: RoutingInstructionState,
  routingStateStore: RoutingInstructionStateStoreLike
): void {
  if (!isPersistentScopeKey(key)) {
    return;
  }
  if (isRoutingStateEmpty(state)) {
    routingStateStore.saveSync?.(key, null) ?? routingStateStore.saveAsync(key, null);
    return;
  }
  if (typeof routingStateStore.saveSync === 'function' && (key.startsWith('session:') || key.startsWith('tmux:'))) {
    routingStateStore.saveSync(key, state);
    return;
  }
  routingStateStore.saveAsync(key, state);
}
