import { failNativeRequired } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.js';
import {
  parseJson,
  parseRecord,
  parseString,
  readNativeFunction,
  resolveRccUserDirWithNative as resolveRccUserDir,
  safeStringify,
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.js';

export const DEFAULT_STOP_MESSAGE_MAX_REPEATS = 10;
const NO_SESSION_DIR_OVERRIDE = '__ROUTECODEX_NO_SESSION_DIR_OVERRIDE__';

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
  stopMessageSource?: string;
  fromHistoricalUserMessage?: boolean;
  preCommandScriptPath?: string;
}

export interface RoutingInstructionState {
  forcedTarget?: Record<string, unknown>;
  preferTarget?: Record<string, unknown>;
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
  stopMessageAiSeedPrompt?: string;
  stopMessageAiHistory?: Array<Record<string, unknown>>;
  preCommandSource?: string;
  preCommandScriptPath?: string;
  preCommandUpdatedAt?: number;
  chatProcessLastTotalTokens?: number;
  chatProcessLastInputTokens?: number;
  chatProcessLastMessageCount?: number;
  chatProcessLastUpdatedAt?: number;
  [key: string]: unknown;
}

export interface RoutingInstructionStateStoreLike {
  loadSync: (key: string) => RoutingInstructionState | null;
  saveAsync: (key: string, state: RoutingInstructionState | null) => void;
  saveSync?: (key: string, state: RoutingInstructionState | null) => void;
}

type RoutingStateErrorEvent = {
  code: string;
  message: string;
  stage: string;
  recoverable: boolean;
  details?: Record<string, unknown>;
};

let routingStateErrorReporter: ((event: RoutingStateErrorEvent) => void) | undefined;

export function setRoutingInstructionStateErrorReporter(
  reporter: ((event: RoutingStateErrorEvent) => void) | undefined,
): void {
  routingStateErrorReporter = reporter;
}

type StandardizedMessage = {
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
};

function stringifyForNative(capability: string, value: unknown): string {
  return safeStringify(value) ?? failNativeRequired<string>(capability, 'json stringify failed');
}

function invokeNativeString(capability: string, args: unknown[]): string {
  const fn = readNativeFunction(capability);
  if (!fn) {
    return failNativeRequired<string>(capability);
  }
  try {
    const result = fn(...args);
    if (typeof result !== 'string' || !result) {
      return failNativeRequired<string>(capability, 'empty result');
    }
    return result;
  } catch (error) {
    return failNativeRequired<string>(capability, error instanceof Error ? error.message : String(error ?? 'unknown'));
  }
}

function parseRecordPayload(capability: string, raw: string): Record<string, unknown> {
  return parseRecord(raw) ?? failNativeRequired<Record<string, unknown>>(capability, 'invalid payload');
}

function plainState(state: RoutingInstructionState | Record<string, unknown>): Record<string, unknown> {
  const record = state as RoutingInstructionState;
  return {
    ...record,
    allowedProviders: Array.from(record.allowedProviders ?? []),
    disabledProviders: Array.from(record.disabledProviders ?? []),
    disabledKeys: Array.from(record.disabledKeys ?? new Map()).map(([provider, keys]) => ({
      provider,
      keys: Array.from(keys),
    })),
    disabledModels: Array.from(record.disabledModels ?? new Map()).map(([provider, models]) => ({
      provider,
      models: Array.from(models),
    })),
  };
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
    disabledModels,
  } as RoutingInstructionState;
}

function normalizeSessionDirOverride(sessionDir?: string): string {
  if (typeof sessionDir !== 'string') {
    return NO_SESSION_DIR_OVERRIDE;
  }
  const trimmed = sessionDir.trim();
  return trimmed || NO_SESSION_DIR_OVERRIDE;
}

function isPersistentScopeKey(key: string | undefined): key is string {
  const capability = 'isRoutingInstructionStatePersistentKeyJson';
  return parseJson(invokeNativeString(capability, [key ?? null])) === true;
}

function isRoutingStateEmpty(state: RoutingInstructionState): boolean {
  const capability = 'isRoutingInstructionStateEmptyJson';
  return parseJson(invokeNativeString(capability, [stringifyForNative(capability, plainState(state))])) === true;
}

function shouldSaveRoutingStateSync(key: string | undefined): boolean {
  const capability = 'shouldSaveRoutingInstructionStateSyncJson';
  return parseJson(invokeNativeString(capability, [key ?? null])) === true;
}

function parseRecordArrayPayload(raw: string): Array<Record<string, unknown>> | null {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) {
    return null;
  }
  const records = parsed.filter(
    (entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ) as Array<Record<string, unknown>>;
  return records.length === parsed.length ? records : null;
}

function readLatestUserMessageText(messages: StandardizedMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'user' || typeof message.content !== 'string') {
      continue;
    }
    const trimmed = message.content.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return '';
}

export function parseRoutingInstructions(messages: StandardizedMessage[]): RoutingInstruction[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }
  const capability = 'parseRoutingInstructionsJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    return failNativeRequired<RoutingInstruction[]>(capability);
  }
  try {
    const result = fn(
      stringifyForNative(capability, messages),
      stringifyForNative(capability, { rccUserDir: resolveRccUserDir() }),
    );
    if (typeof result !== 'string' || !result) {
      return failNativeRequired<RoutingInstruction[]>(capability, 'empty result');
    }
    const instructions = parseRecordArrayPayload(result);
    if (!instructions) {
      return failNativeRequired<RoutingInstruction[]>(capability, 'invalid payload');
    }
    const latestUserMessage = readLatestUserMessageText(messages);
    if (!latestUserMessage || !latestUserMessage.includes('\u200BstopMessage')) {
      return instructions as unknown as RoutingInstruction[];
    }
    return (instructions as unknown as RoutingInstruction[]).filter((inst) => !(
      inst.type === 'stopMessageSet' ||
      inst.type === 'stopMessageMode' ||
      inst.type === 'stopMessageClear'
    ));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<RoutingInstruction[]>(capability, reason);
  }
}

export function applyRoutingInstructionsWithNative(input: {
  instructions: Array<Record<string, unknown>>;
  state: Record<string, unknown>;
}): Record<string, unknown> {
  const capability = 'applyRoutingInstructionsJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    return failNativeRequired<Record<string, unknown>>(capability);
  }
  try {
    const result = fn(stringifyForNative(capability, input));
    if (typeof result !== 'string' || !result) {
      return failNativeRequired<Record<string, unknown>>(capability, 'empty result');
    }
    return parseRecord(result) ?? failNativeRequired<Record<string, unknown>>(capability, 'invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<Record<string, unknown>>(capability, reason);
  }
}

export function serializeRoutingInstructionState(state: RoutingInstructionState): Record<string, unknown> {
  const capability = 'serializeRoutingInstructionStateJson';
  return parseRecordPayload(capability, invokeNativeString(capability, [stringifyForNative(capability, plainState(state))]));
}

export function deserializeRoutingInstructionState(data: Record<string, unknown>): RoutingInstructionState {
  const capability = 'deserializeRoutingInstructionStateJson';
  return hydrateState(parseRecordPayload(capability, invokeNativeString(capability, [stringifyForNative(capability, data)])));
}

export function resolveRoutingStateKey(metadata: Record<string, unknown>): string {
  const capability = 'resolveVirtualRouterRoutingStateKeyJson';
  const raw = invokeNativeString(capability, [stringifyForNative(capability, metadata ?? null)]);
  return parseString(raw) ?? failNativeRequired<string>(capability, 'invalid payload');
}

export function loadRoutingInstructionStateSync(
  key: string | undefined,
  sessionDir?: string,
): RoutingInstructionState | null {
  if (!isPersistentScopeKey(key)) {
    throw new Error('Routing state key missing or invalid; failing fast per no-fallback policy');
  }
  const capability = 'loadRoutingInstructionStateJson';
  const parsed = parseJson(invokeNativeString(capability, [key, normalizeSessionDirOverride(sessionDir)]));
  if (parsed === null) return null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failNativeRequired<RoutingInstructionState | null>(capability, 'invalid payload');
  }
  return hydrateState(parsed as Record<string, unknown>);
}

export function saveRoutingInstructionStateSync(
  key: string | undefined,
  state: RoutingInstructionState | null,
  sessionDir?: string,
): void {
  if (!isPersistentScopeKey(key)) {
    return;
  }
  const capability = 'saveRoutingInstructionStateJson';
  const payload = state ? serializeRoutingInstructionState(state) : null;
  invokeNativeString(capability, [key, stringifyForNative(capability, payload), normalizeSessionDirOverride(sessionDir)]);
}

export function saveRoutingInstructionStateAsync(
  key: string | undefined,
  state: RoutingInstructionState | null,
  sessionDir?: string,
): void {
  saveRoutingInstructionStateSync(key, state, sessionDir);
}

export function mergeStopMessageFromPersisted(
  existing: RoutingInstructionState | Record<string, unknown>,
  persisted: RoutingInstructionState | Record<string, unknown> | null,
): RoutingInstructionState {
  const capability = 'mergeStopMessageFromPersistedJson';
  const raw = invokeNativeString(capability, [
    stringifyForNative(capability, plainState(existing as RoutingInstructionState)),
    stringifyForNative(capability, persisted ? plainState(persisted as RoutingInstructionState) : null),
  ]);
  return hydrateState(parseRecordPayload(capability, raw));
}

export function getRoutingInstructionState(
  routingStateKey: string | undefined,
  routingInstructionState: Map<string, RoutingInstructionState>,
  routingStateStore: RoutingInstructionStateStoreLike,
): RoutingInstructionState {
  const key = routingStateKey || 'default';
  const existing = routingInstructionState.get(key);
  if (existing) {
    if (isPersistentScopeKey(key)) {
      try {
        const persisted = routingStateStore.loadSync(key);
        const merged = mergeStopMessageFromPersisted(existing, persisted);
        Object.assign(existing, merged);
        if (persisted) {
          existing.preCommandSource = persisted.preCommandSource;
          existing.preCommandScriptPath = persisted.preCommandScriptPath;
          existing.preCommandUpdatedAt = persisted.preCommandUpdatedAt;
        }
      } catch (error) {
        routingStateErrorReporter?.({
          code: 'ROUTING_STATE_REFRESH_FAILED',
          message: error instanceof Error ? error.message : String(error ?? 'routing state refresh failed'),
          stage: 'routing_state.refresh',
          recoverable: true,
          details: {
            operation: 'refresh_existing_state',
            key,
          },
        });
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
  routingStateStore: RoutingInstructionStateStoreLike,
): void {
  if (!isPersistentScopeKey(key)) {
    return;
  }
  if (isRoutingStateEmpty(state)) {
    routingStateStore.saveSync?.(key, null) ?? routingStateStore.saveAsync(key, null);
    return;
  }
  if (typeof routingStateStore.saveSync === 'function' && shouldSaveRoutingStateSync(key)) {
    routingStateStore.saveSync(key, state);
    return;
  }
  routingStateStore.saveAsync(key, state);
}
