import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
export type NativeGovernanceContextPayload = {
  entryEndpoint: string;
  metadata: Record<string, unknown>;
  providerProtocol: string;
  metadataToolHints: unknown;
  inboundStreamIntent: boolean;
  rawRequestBody?: Record<string, unknown>;
};
export type NativeRespProcessToolGovernanceInput = {
  payload: Record<string, unknown>;
  clientProtocol: string;
  entryEndpoint: string;
  requestId: string;
};
export type NativeRespProcessToolGovernanceOutput = {
  governedPayload: Record<string, unknown>;
  summary: {
    applied: boolean;
    toolCallsNormalized: number;
    applyPatchRepaired: number;
  };
};
export type NativeRespProcessToolGovernancePreparationOutput = {
  preparedPayload: Record<string, unknown>;
  summary: {
    converted: boolean;
    shapeSanitized: boolean;
    harvestedToolCalls: number;
  };
};
export type NativeRespProcessFinalizeInput = {
  payload: Record<string, unknown>;
  stream: boolean;
  reasoningMode?: string;
  endpoint?: string;
  requestId?: string;
};
function parseAliasMapPayload(raw: string): Record<string, unknown> | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key || typeof value !== 'string') {
        return null;
      }
      out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}
function parseGovernanceContextPayload(raw: string): NativeGovernanceContextPayload | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const entryEndpoint = typeof row.entryEndpoint === 'string' ? row.entryEndpoint : '';
    const providerProtocol = typeof row.providerProtocol === 'string' ? row.providerProtocol : '';
    const inboundStreamIntent = row.inboundStreamIntent === true;
    const metadata =
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : null;
    if (!entryEndpoint || !providerProtocol || !metadata) {
      return null;
    }
    const rawRequestBody =
      row.rawRequestBody && typeof row.rawRequestBody === 'object' && !Array.isArray(row.rawRequestBody)
        ? (row.rawRequestBody as Record<string, unknown>)
        : undefined;
    return {
      entryEndpoint,
      metadata,
      providerProtocol,
      metadataToolHints: row.metadataToolHints === null ? undefined : row.metadataToolHints,
      inboundStreamIntent,
      ...(rawRequestBody ? { rawRequestBody } : {})
    };
  } catch {
    return null;
  }
}
function parseCastToolsPayload(raw: string): unknown | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return undefined;
    }
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
function parseWebSearchOperationsPayload(raw: string): unknown[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed;
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
function parseRespProcessToolGovernancePayload(raw: string): NativeRespProcessToolGovernanceOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const governedPayloadRaw =
      row.governed_payload && typeof row.governed_payload === 'object' && !Array.isArray(row.governed_payload)
        ? (row.governed_payload as Record<string, unknown>)
        : row.governedPayload && typeof row.governedPayload === 'object' && !Array.isArray(row.governedPayload)
          ? (row.governedPayload as Record<string, unknown>)
          : null;
    const summaryRaw =
      row.summary && typeof row.summary === 'object' && !Array.isArray(row.summary)
        ? (row.summary as Record<string, unknown>)
        : null;
    if (!governedPayloadRaw || !summaryRaw) {
      return null;
    }
    const applied = summaryRaw.applied === true;
    const toolCallsNormalizedRaw =
      typeof summaryRaw.tool_calls_normalized === 'number'
        ? summaryRaw.tool_calls_normalized
        : typeof summaryRaw.toolCallsNormalized === 'number'
          ? summaryRaw.toolCallsNormalized
          : NaN;
    const applyPatchRepairedRaw =
      typeof summaryRaw.apply_patch_repaired === 'number'
        ? summaryRaw.apply_patch_repaired
        : typeof summaryRaw.applyPatchRepaired === 'number'
          ? summaryRaw.applyPatchRepaired
          : NaN;
    if (!Number.isFinite(toolCallsNormalizedRaw) || !Number.isFinite(applyPatchRepairedRaw)) {
      return null;
    }
    return {
      governedPayload: governedPayloadRaw,
      summary: {
        applied,
        toolCallsNormalized: Math.floor(toolCallsNormalizedRaw),
        applyPatchRepaired: Math.floor(applyPatchRepairedRaw)
      }
    };
  } catch {
    return null;
  }
}
function parseRespProcessToolGovernancePreparationPayload(
  raw: string
): NativeRespProcessToolGovernancePreparationOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const preparedPayloadRaw =
      row.prepared_payload && typeof row.prepared_payload === 'object' && !Array.isArray(row.prepared_payload)
        ? (row.prepared_payload as Record<string, unknown>)
        : row.preparedPayload && typeof row.preparedPayload === 'object' && !Array.isArray(row.preparedPayload)
          ? (row.preparedPayload as Record<string, unknown>)
          : null;
    const summaryRaw =
      row.summary && typeof row.summary === 'object' && !Array.isArray(row.summary)
        ? (row.summary as Record<string, unknown>)
        : null;
    if (!preparedPayloadRaw || !summaryRaw) {
      return null;
    }
    const converted = summaryRaw.converted === true;
    const shapeSanitized = summaryRaw.shape_sanitized === true || summaryRaw.shapeSanitized === true;
    const harvestedToolCallsRaw =
      typeof summaryRaw.harvested_tool_calls === 'number'
        ? summaryRaw.harvested_tool_calls
        : typeof summaryRaw.harvestedToolCalls === 'number'
          ? summaryRaw.harvestedToolCalls
          : NaN;
    if (!Number.isFinite(harvestedToolCallsRaw)) {
      return null;
    }
    return {
      preparedPayload: preparedPayloadRaw,
      summary: {
        converted,
        shapeSanitized,
        harvestedToolCalls: Math.floor(harvestedToolCallsRaw)
      }
    };
  } catch {
    return null;
  }
}
function parseRespProcessFinalizePayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const finalizedPayloadRaw =
      row.finalized_payload && typeof row.finalized_payload === 'object' && !Array.isArray(row.finalized_payload)
        ? (row.finalized_payload as Record<string, unknown>)
        : row.finalizedPayload && typeof row.finalizedPayload === 'object' && !Array.isArray(row.finalizedPayload)
          ? (row.finalizedPayload as Record<string, unknown>)
          : null;
    return finalizedPayloadRaw;
  } catch {
    return null;
  }
}
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
function encodeJsonArg(capability: string, value: unknown): string {
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  const encoded = safeStringify(value);
  if (!encoded) {
    return fail('json stringify failed');
  }
  return encoded;
}
function invokeNativeStringCapability(capability: string, args: unknown[]): string {
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(...args);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return raw;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
function invokeNativeStringCapabilityWithJsonArgs(capability: string, args: unknown[]): string {
  return invokeNativeStringCapability(
    capability,
    args.map((arg) => encodeJsonArg(capability, arg))
  );
}
export function buildAnthropicToolAliasMapWithNative(
  sourceTools: unknown
): Record<string, unknown> | undefined {
  const capability = 'buildAnthropicToolAliasMapJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | undefined>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [sourceTools ?? null]);
    const parsed = parseAliasMapPayload(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
export function resolveGovernanceContextWithNative(
  request: unknown,
  context: unknown
): NativeGovernanceContextPayload {
  const capability = 'resolveGovernanceContextJson';
  const fail = (reason?: string): NativeGovernanceContextPayload =>
    failNativeRequired<NativeGovernanceContextPayload>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [request ?? null, context ?? null]);
    const parsed = parseGovernanceContextPayload(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
export function castGovernedToolsWithNative(
  tools: unknown
): unknown {
  const capability = 'castGovernedToolsJson';
  const fail = (reason?: string): unknown => failNativeRequired<unknown>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [tools ?? null]);
    const parsed = parseCastToolsPayload(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
export function buildWebSearchToolAppendOperationsWithNative(
  engines: unknown
): unknown[] {
  const capability = 'buildWebSearchToolAppendOperationsJson';
  const fail = (reason?: string): unknown[] => failNativeRequired<unknown[]>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [engines ?? null]);
    const parsed = parseWebSearchOperationsPayload(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
export function applyGovernedControlOperationsWithNative(
  request: Record<string, unknown>,
  governed: Record<string, unknown>,
  inboundStreamIntent: boolean
): Record<string, unknown> {
  const capability = 'applyGovernedControlOperationsJson';
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [request, governed, inboundStreamIntent === true]);
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
export function applyGovernedMergeRequestWithNative(
  request: Record<string, unknown>,
  governed: Record<string, unknown>,
  inboundStreamIntent: boolean,
  governanceTimestampMs: number
): Record<string, unknown> {
  const capability = 'applyGovernedMergeRequestJson';
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [
      request,
      governed,
      inboundStreamIntent === true,
      Number.isFinite(governanceTimestampMs) ? governanceTimestampMs : Date.now()
    ]);
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
export function mergeGovernanceSummaryIntoMetadataWithNative(
  metadata: Record<string, unknown> | undefined,
  summary: Record<string, unknown>
): Record<string, unknown> {
  const capability = 'mergeGovernanceSummaryIntoMetadataJson';
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [metadata ?? {}, summary ?? {}]);
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
export function finalizeGovernedRequestWithNative(
  request: Record<string, unknown>,
  summary: Record<string, unknown>
): Record<string, unknown> {
  const capability = 'finalizeGovernedRequestJson';
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [request ?? {}, summary ?? {}]);
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
export function applyRespProcessToolGovernanceWithNative(
  input: NativeRespProcessToolGovernanceInput
): NativeRespProcessToolGovernanceOutput {
  const capability = 'governResponseJson';
  const fail = (reason?: string): NativeRespProcessToolGovernanceOutput =>
    failNativeRequired<NativeRespProcessToolGovernanceOutput>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [{
      payload: input.payload,
      client_protocol: input.clientProtocol,
      entry_endpoint: input.entryEndpoint,
      request_id: input.requestId
    }]);
    const parsed = parseRespProcessToolGovernancePayload(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
export function prepareRespProcessToolGovernancePayloadWithNative(
  payload: Record<string, unknown>
): NativeRespProcessToolGovernancePreparationOutput {
  const capability = 'prepareRespProcessToolGovernancePayloadJson';
  const fail = (reason?: string): NativeRespProcessToolGovernancePreparationOutput =>
    failNativeRequired<NativeRespProcessToolGovernancePreparationOutput>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [payload ?? {}]);
    const parsed = parseRespProcessToolGovernancePreparationPayload(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
export function stripOrphanFunctionCallsTagWithNative(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const capability = 'stripOrphanFunctionCallsTagJson';
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [payload]);
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
export async function finalizeRespProcessChatResponseWithNative(
  input: NativeRespProcessFinalizeInput
): Promise<Record<string, unknown>> {
  const capability = 'finalizeChatResponseJson';
  const fail = async (reason?: string): Promise<Record<string, unknown>> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [{
      payload: input.payload,
      stream: input.stream === true,
      reasoningMode: input.reasoningMode,
      endpoint: input.endpoint,
      requestId: input.requestId
    }]);
    const parsed = parseRespProcessFinalizePayload(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
