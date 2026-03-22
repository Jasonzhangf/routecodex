import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

type HubPipelineInput = {
  requestId: string;
  endpoint: string;
  entryEndpoint: string;
  providerProtocol: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  stream: boolean;
  processMode: 'chat' | 'passthrough';
  direction: 'request' | 'response';
  stage: 'inbound' | 'outbound';
};

type HubPipelineOutput = {
  requestId: string;
  success: boolean;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
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

function parseString(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
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

function parseOptionalString(raw: string): string | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return undefined;
    }
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function parseOptionalBoolean(raw: string): boolean | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return undefined;
    }
    return typeof parsed === 'boolean' ? parsed : null;
  } catch {
    return null;
  }
}

function parseOrchestrationOutput(raw: string): HubPipelineOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const requestId = typeof row.requestId === 'string' ? row.requestId : '';
    const success = row.success === true;
    if (!requestId) {
      return null;
    }
    const output: HubPipelineOutput = { requestId, success };
    if (row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)) {
      output.payload = row.payload as Record<string, unknown>;
    }
    if (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)) {
      output.metadata = row.metadata as Record<string, unknown>;
    }
    if (row.error && typeof row.error === 'object' && !Array.isArray(row.error)) {
      const err = row.error as Record<string, unknown>;
      const code = typeof err.code === 'string' ? err.code.trim() : '';
      const message = typeof err.message === 'string' ? err.message.trim() : '';
      if (code && message) {
        output.error = {
          code,
          message,
          ...(Object.prototype.hasOwnProperty.call(err, 'details') ? { details: err.details } : {})
        };
      }
    }
    return output;
  } catch {
    return null;
  }
}

export function runHubPipelineOrchestrationWithNative(
  input: HubPipelineInput
): HubPipelineOutput {
  const capability = 'runHubPipelineJson';
  const fail = (reason?: string) => failNativeRequired<HubPipelineOutput>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseOrchestrationOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeHubEndpointWithNative(endpoint: string): string {
  const capability = 'normalizeHubEndpointJson';
  const fail = (reason?: string): string => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(String(endpoint || ''));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseString(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveHubProviderProtocolWithNative(value: unknown): string {
  const capability = 'resolveProviderProtocolJson';
  const fail = (reason?: string): string => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const normalizedInput = typeof value === 'string' ? value : '';
  try {
    const raw = fn(normalizedInput);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseString(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveHubClientProtocolWithNative(entryEndpoint: string): string {
  const capability = 'resolveHubClientProtocolJson';
  const fail = (reason?: string): string => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(String(entryEndpoint || ''));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseString(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveOutboundStreamIntentWithNative(
  providerPreference: unknown
): boolean | undefined {
  const capability = 'resolveOutboundStreamIntentJson';
  const fail = (reason?: string): boolean | undefined =>
    failNativeRequired<boolean | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const preferenceJson = safeStringify(providerPreference ?? null);
  if (!preferenceJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(preferenceJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseOptionalBoolean(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyOutboundStreamPreferenceWithNative(
  request: Record<string, unknown>,
  stream: boolean | undefined,
  processMode?: 'chat' | 'passthrough'
): Record<string, unknown> {
  const capability = 'applyOutboundStreamPreferenceJson';
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const requestJson = safeStringify(request ?? {});
  const streamJson = safeStringify(stream ?? null);
  const modeJson = safeStringify(processMode ?? null);
  if (!requestJson || !streamJson || !modeJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(requestJson, streamJson, modeJson);
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

export function resolveHubSseProtocolFromMetadataWithNative(
  metadata: Record<string, unknown>
): string | undefined {
  const capability = 'resolveSseProtocolFromMetadataJson';
  const fail = (reason?: string): string | undefined =>
    failNativeRequired<string | undefined>(capability, reason);
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
    const parsed = parseOptionalString(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveSseProtocolWithNative(
  metadata: Record<string, unknown>,
  providerProtocol: string
): string {
  const capability = 'resolveSseProtocolJson';
  const fail = (reason?: string): string => failNativeRequired<string>(capability, reason);
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
    const raw = fn(metadataJson, String(providerProtocol || ''));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseString(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractModelHintFromMetadataWithNative(
  metadata: Record<string, unknown>
): string | undefined {
  const capability = 'extractModelHintFromMetadataJson';
  const fail = (reason?: string): string | undefined =>
    failNativeRequired<string | undefined>(capability, reason);
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
    const parsed = parseOptionalString(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
