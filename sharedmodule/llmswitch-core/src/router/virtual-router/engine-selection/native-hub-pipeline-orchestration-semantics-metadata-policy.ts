import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

type StopMessageRouterMetadataOutput = {
  stopMessageClientInjectSessionScope?: string;
  stopMessageClientInjectScope?: string;
  clientTmuxSessionId?: string;
  client_tmux_session_id?: string;
  tmuxSessionId?: string;
  tmux_session_id?: string;
};

type RouterMetadataRuntimeFlagsOutput = {
  disableStickyRoutes?: boolean;
  estimatedInputTokens?: number;
};

type AdapterContextMetadataSignalsOutput = {
  clientRequestId?: string;
  groupRequestId?: string;
  originalModelId?: string;
  clientModelId?: string;
  modelId?: string;
  estimatedInputTokens?: number;
  sessionId?: string;
  conversationId?: string;
};

type AdapterContextObjectCarriersOutput = {
  runtime?: Record<string, unknown>;
  capturedChatRequest?: Record<string, unknown>;
  clientConnectionState?: Record<string, unknown>;
  clientDisconnected?: boolean;
};

type HubPolicyOverrideOutput = {
  mode: 'off' | 'observe' | 'enforce';
  sampleRate?: number;
};

type HubShadowCompareConfigOutput = {
  baselineMode: 'off' | 'observe' | 'enforce';
};


function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseStopMessageRouterMetadata(raw: string): StopMessageRouterMetadataOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const out: StopMessageRouterMetadataOutput = {};
    const assignIfNonEmpty = (key: keyof StopMessageRouterMetadataOutput): void => {
      const rawValue = row[key];
      if (typeof rawValue !== 'string') {
        return;
      }
      const trimmed = rawValue.trim();
      if (!trimmed) {
        return;
      }
      out[key] = trimmed;
    };
    assignIfNonEmpty('stopMessageClientInjectSessionScope');
    assignIfNonEmpty('stopMessageClientInjectScope');
    assignIfNonEmpty('clientTmuxSessionId');
    assignIfNonEmpty('client_tmux_session_id');
    assignIfNonEmpty('tmuxSessionId');
    assignIfNonEmpty('tmux_session_id');
    return out;
  } catch {
    return null;
  }
}

function parseRouterMetadataRuntimeFlags(raw: string): RouterMetadataRuntimeFlagsOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const out: RouterMetadataRuntimeFlagsOutput = {};
    if (row.disableStickyRoutes === true) {
      out.disableStickyRoutes = true;
    }
    if (typeof row.estimatedInputTokens === 'number' && Number.isFinite(row.estimatedInputTokens)) {
      out.estimatedInputTokens = row.estimatedInputTokens;
    }
    return out;
  } catch {
    return null;
  }
}

function parseAdapterContextMetadataSignals(raw: string): AdapterContextMetadataSignalsOutput | null {
  const parsed = parseRecord(raw);
  if (!parsed) {
    return null;
  }
  const out: AdapterContextMetadataSignalsOutput = {};
  const stringKeys: Array<keyof Omit<AdapterContextMetadataSignalsOutput, 'estimatedInputTokens'>> = [
    'clientRequestId',
    'groupRequestId',
    'originalModelId',
    'clientModelId',
    'modelId',
    'sessionId',
    'conversationId'
  ];
  for (const key of stringKeys) {
    if (!(key in parsed)) {
      continue;
    }
    if (typeof parsed[key] !== 'string') {
      return null;
    }
    out[key] = parsed[key] as string;
  }
  if ('estimatedInputTokens' in parsed) {
    if (typeof parsed.estimatedInputTokens !== 'number' || !Number.isFinite(parsed.estimatedInputTokens)) {
      return null;
    }
    out.estimatedInputTokens = parsed.estimatedInputTokens;
  }
  return out;
}

function parseAdapterContextObjectCarriers(raw: string): AdapterContextObjectCarriersOutput | null {
  const parsed = parseRecord(raw);
  if (!parsed) {
    return null;
  }
  const out: AdapterContextObjectCarriersOutput = {};
  if ('runtime' in parsed) {
    if (!parsed.runtime || typeof parsed.runtime !== 'object' || Array.isArray(parsed.runtime)) {
      return null;
    }
    out.runtime = parsed.runtime as Record<string, unknown>;
  }
  if ('capturedChatRequest' in parsed) {
    if (!parsed.capturedChatRequest || typeof parsed.capturedChatRequest !== 'object' || Array.isArray(parsed.capturedChatRequest)) {
      return null;
    }
    out.capturedChatRequest = parsed.capturedChatRequest as Record<string, unknown>;
  }
  if ('clientConnectionState' in parsed) {
    if (!parsed.clientConnectionState || typeof parsed.clientConnectionState !== 'object' || Array.isArray(parsed.clientConnectionState)) {
      return null;
    }
    out.clientConnectionState = parsed.clientConnectionState as Record<string, unknown>;
  }
  if ('clientDisconnected' in parsed) {
    if (typeof parsed.clientDisconnected !== 'boolean') {
      return null;
    }
    out.clientDisconnected = parsed.clientDisconnected;
  }
  return out;
}

function parseHubPolicyOverride(raw: string): HubPolicyOverrideOutput | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const mode = typeof row.mode === 'string' ? row.mode.trim().toLowerCase() : '';
    if (mode !== 'off' && mode !== 'observe' && mode !== 'enforce') {
      return null;
    }
    const out: HubPolicyOverrideOutput = { mode };
    if (typeof row.sampleRate === 'number' && Number.isFinite(row.sampleRate)) {
      out.sampleRate = row.sampleRate;
    }
    return out;
  } catch {
    return null;
  }
}

function parseHubShadowCompareConfig(raw: string): HubShadowCompareConfigOutput | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const baselineMode = typeof row.baselineMode === 'string' ? row.baselineMode.trim().toLowerCase() : '';
    if (baselineMode !== 'off' && baselineMode !== 'observe' && baselineMode !== 'enforce') {
      return null;
    }
    return { baselineMode };
  } catch {
    return null;
  }
}

export function resolveStopMessageRouterMetadataWithNative(
  metadata: Record<string, unknown> | undefined
): StopMessageRouterMetadataOutput {
  const capability = 'resolveStopMessageRouterMetadataJson';
  const fail = (reason?: string): StopMessageRouterMetadataOutput =>
    failNativeRequired<StopMessageRouterMetadataOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? null);
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseStopMessageRouterMetadata(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveRouterMetadataRuntimeFlagsWithNative(
  metadata: Record<string, unknown> | undefined
): RouterMetadataRuntimeFlagsOutput {
  const capability = 'resolveRouterMetadataRuntimeFlagsJson';
  const fail = (reason?: string): RouterMetadataRuntimeFlagsOutput =>
    failNativeRequired<RouterMetadataRuntimeFlagsOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? null);
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRouterMetadataRuntimeFlags(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractAdapterContextMetadataFieldsWithNative(
  metadata: Record<string, unknown>,
  keys: string[]
): Record<string, unknown> {
  const capability = 'extractAdapterContextMetadataFieldsJson';
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? {});
  const keysJson = safeStringify(Array.isArray(keys) ? keys : []);
  if (!metadataJson || !keysJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson, keysJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveAdapterContextMetadataSignalsWithNative(
  metadata: Record<string, unknown>
): AdapterContextMetadataSignalsOutput {
  const capability = 'resolveAdapterContextMetadataSignalsJson';
  const fail = (reason?: string): AdapterContextMetadataSignalsOutput =>
    failNativeRequired<AdapterContextMetadataSignalsOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? {});
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseAdapterContextMetadataSignals(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveAdapterContextObjectCarriersWithNative(
  metadata: Record<string, unknown>
): AdapterContextObjectCarriersOutput {
  const capability = 'resolveAdapterContextObjectCarriersJson';
  const fail = (reason?: string): AdapterContextObjectCarriersOutput =>
    failNativeRequired<AdapterContextObjectCarriersOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? {});
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseAdapterContextObjectCarriers(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveHubPolicyOverrideFromMetadataWithNative(
  metadata: Record<string, unknown> | undefined
): HubPolicyOverrideOutput | undefined {
  const capability = 'resolveHubPolicyOverrideJson';
  const fail = (reason?: string): HubPolicyOverrideOutput | undefined =>
    failNativeRequired<HubPolicyOverrideOutput | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? null);
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseHubPolicyOverride(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveHubShadowCompareConfigWithNative(
  metadata: Record<string, unknown> | undefined
): HubShadowCompareConfigOutput | undefined {
  const capability = 'resolveHubShadowCompareConfigJson';
  const fail = (reason?: string): HubShadowCompareConfigOutput | undefined =>
    failNativeRequired<HubShadowCompareConfigOutput | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? null);
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseHubShadowCompareConfig(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
