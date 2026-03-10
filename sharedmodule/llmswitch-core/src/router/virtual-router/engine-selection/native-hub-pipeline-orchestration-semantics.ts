import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export interface NativeHubPipelineOrchestrationInput {
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
}

export interface NativeHubPipelineOrchestrationOutput {
  requestId: string;
  success: boolean;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface NativeStopMessageRouterMetadataOutput {
  stopMessageClientInjectSessionScope?: string;
  stopMessageClientInjectScope?: string;
  clientTmuxSessionId?: string;
  client_tmux_session_id?: string;
  tmuxSessionId?: string;
  tmux_session_id?: string;
}

export interface NativeHubPolicyOverrideOutput {
  mode: 'off' | 'observe' | 'enforce';
  sampleRate?: number;
}

export interface NativeHubShadowCompareConfigOutput {
  baselineMode: 'off' | 'observe' | 'enforce';
}

export type NativeApplyPatchToolMode = 'schema' | 'freeform';

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

function parseOrchestrationOutput(raw: string): NativeHubPipelineOrchestrationOutput | null {
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
    const output: NativeHubPipelineOrchestrationOutput = {
      requestId,
      success
    };
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

function parseString(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'string' ? parsed : null;
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

function parseBoolean(raw: string): boolean | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'boolean' ? parsed : null;
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

function parseStopMessageRouterMetadata(raw: string): NativeStopMessageRouterMetadataOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const out: NativeStopMessageRouterMetadataOutput = {};
    const assignIfNonEmpty = (key: keyof NativeStopMessageRouterMetadataOutput): void => {
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

function parseHubPolicyOverride(raw: string): NativeHubPolicyOverrideOutput | undefined | null {
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
    const out: NativeHubPolicyOverrideOutput = { mode };
    if (typeof row.sampleRate === 'number' && Number.isFinite(row.sampleRate)) {
      out.sampleRate = row.sampleRate;
    }
    return out;
  } catch {
    return null;
  }
}

function parseHubShadowCompareConfig(raw: string): NativeHubShadowCompareConfigOutput | undefined | null {
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

function parseApplyPatchToolMode(raw: string): NativeApplyPatchToolMode | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return undefined;
    }
    if (typeof parsed !== 'string') {
      return null;
    }
    const mode = parsed.trim().toLowerCase();
    if (mode === 'schema' || mode === 'freeform') {
      return mode as NativeApplyPatchToolMode;
    }
    return null;
  } catch {
    return null;
  }
}

function parseStringArray(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const out: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'string') {
        return null;
      }
      out.push(entry);
    }
    return out;
  } catch {
    return null;
  }
}

export function runHubPipelineOrchestrationWithNative(
  input: NativeHubPipelineOrchestrationInput
): NativeHubPipelineOrchestrationOutput {
  const capability = 'runHubPipelineJson';
  const fail = (reason?: string) => failNativeRequired<NativeHubPipelineOrchestrationOutput>(capability, reason);

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

export function resolveStopMessageRouterMetadataWithNative(
  metadata: Record<string, unknown> | undefined
): NativeStopMessageRouterMetadataOutput {
  const capability = 'resolveStopMessageRouterMetadataJson';
  const fail = (reason?: string): NativeStopMessageRouterMetadataOutput =>
    failNativeRequired<NativeStopMessageRouterMetadataOutput>(capability, reason);

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

export function resolveHubPolicyOverrideFromMetadataWithNative(
  metadata: Record<string, unknown> | undefined
): NativeHubPolicyOverrideOutput | undefined {
  const capability = 'resolveHubPolicyOverrideJson';
  const fail = (reason?: string): NativeHubPolicyOverrideOutput | undefined =>
    failNativeRequired<NativeHubPolicyOverrideOutput | undefined>(capability, reason);

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
): NativeHubShadowCompareConfigOutput | undefined {
  const capability = 'resolveHubShadowCompareConfigJson';
  const fail = (reason?: string): NativeHubShadowCompareConfigOutput | undefined =>
    failNativeRequired<NativeHubShadowCompareConfigOutput | undefined>(capability, reason);

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

export function resolveApplyPatchToolModeFromToolsWithNative(
  toolsRaw: unknown
): NativeApplyPatchToolMode | undefined {
  const capability = 'resolveApplyPatchToolModeFromToolsJson';
  const fail = (reason?: string): NativeApplyPatchToolMode | undefined =>
    failNativeRequired<NativeApplyPatchToolMode | undefined>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const toolsJson = safeStringify(toolsRaw ?? null);
  if (!toolsJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(toolsJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseApplyPatchToolMode(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveHasInstructionRequestedPassthroughWithNative(
  messages: unknown
): boolean {
  const capability = 'resolveHasInstructionRequestedPassthroughJson';
  const fail = (reason?: string): boolean => failNativeRequired<boolean>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const messagesJson = safeStringify(messages ?? null);
  if (!messagesJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(messagesJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseBoolean(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveActiveProcessModeWithNative(
  baseMode: 'chat' | 'passthrough',
  messages: unknown
): 'chat' | 'passthrough' {
  const capability = 'resolveActiveProcessModeJson';
  const fail = (reason?: string): 'chat' | 'passthrough' =>
    failNativeRequired<'chat' | 'passthrough'>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const baseModeJson = safeStringify(baseMode);
  const messagesJson = safeStringify(messages ?? null);
  if (!baseModeJson || !messagesJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(baseModeJson, messagesJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseString(raw);
    if (parsed === 'chat' || parsed === 'passthrough') {
      return parsed;
    }
    return fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function findMappableSemanticsKeysWithNative(
  metadata: unknown
): string[] {
  const capability = 'findMappableSemanticsKeysJson';
  const fail = (reason?: string): string[] => failNativeRequired<string[]>(capability, reason);

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
    const parsed = parseStringArray(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildPassthroughAuditWithNative(
  rawInbound: Record<string, unknown>,
  providerProtocol: string
): Record<string, unknown> {
  const capability = 'buildPassthroughAuditJson';
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }

  const inboundJson = safeStringify(rawInbound ?? {});
  if (!inboundJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inboundJson, String(providerProtocol || ''));
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

export function annotatePassthroughGovernanceSkipWithNative(
  audit: Record<string, unknown>
): Record<string, unknown> {
  const capability = 'annotatePassthroughGovernanceSkipJson';
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }

  const auditJson = safeStringify(audit ?? {});
  if (!auditJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(auditJson);
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

export function attachPassthroughProviderInputAuditWithNative(
  audit: Record<string, unknown>,
  providerPayload: Record<string, unknown>,
  providerProtocol: string
): Record<string, unknown> {
  const capability = 'attachPassthroughProviderInputAuditJson';
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }

  const auditJson = safeStringify(audit ?? {});
  const payloadJson = safeStringify(providerPayload ?? {});
  if (!auditJson || !payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(auditJson, payloadJson, String(providerProtocol || ''));
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
