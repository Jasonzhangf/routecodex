import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import { formatUnknownError } from '../../shared/common-utils.js';
import type { ProviderProtocolErrorCode } from '../../conversion/provider-protocol-error.js';

type HubPipelineInput = {
  requestId: string;
  endpoint: string;
  entryEndpoint: string;
  providerProtocol: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  metadataCenterSnapshot?: {
    requestTruth?: Record<string, unknown>;
    continuationContext?: Record<string, unknown>;
    runtimeControl?: Record<string, unknown>;
  };
  stream: boolean;
  processMode: 'chat';
  direction: 'request' | 'response';
  stage: string;
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

type HubPipelineLibInput = {
  config?: Record<string, unknown>;
  request: HubPipelineInput;
};

type HubPipelineLibOutput = HubPipelineOutput & {
  standardizedRequest?: Record<string, unknown>;
  entryOriginRequest?: Record<string, unknown>;
  effectPlan: {
    effects: Array<Record<string, unknown>>;
  };
  diagnostics: Array<Record<string, unknown>>;
};

export type ProviderResponseRuntimeEffectPlan = {
  streamPipe?: {
    codec: string;
    requestId: string;
    payload?: Record<string, unknown>;
    body?: Record<string, unknown>;
  } | null;
  runtimeStateWrite?: Record<string, unknown> | null;
  stoplessMetadataCenterWrite?: Record<string, unknown> | null;
  servertoolRuntimeActions: Array<Record<string, unknown>>;
};

export type ProviderResponseServertoolRuntimeExecutionPlan = {
  payload: Record<string, unknown>;
  projectionStage: 'HubRespChatProcess03Governed';
  allowFollowup: boolean;
  stopGateway?: Record<string, unknown> | null;
};

export type ProviderResponseServertoolRuntimeErrorDescriptor = {
  message: string;
  code: ProviderProtocolErrorCode;
  category: 'INTERNAL_ERROR';
  details: Record<string, unknown>;
};

export type ProviderResponseServertoolRuntimeActionPlan = {
  executionPlans: ProviderResponseServertoolRuntimeExecutionPlan[];
  error?: ProviderResponseServertoolRuntimeErrorDescriptor | null;
};

export type ProviderResponsePostServertoolEffectPlan = {
  payload: Record<string, unknown>;
  stage: 'HubRespChatProcess03Governed' | 'unchanged';
  shouldProjectClientSemantic: boolean;
};

export type ProviderProtocolPlan = {
  providerProtocol: string;
};

export type RequestStageMetadataDispatchPlan = {
  metadata: Record<string, unknown>;
  metadataCenterSnapshot?: Record<string, unknown> | null;
};

function readServertoolRuntimeErrorCode(value: unknown): ProviderProtocolErrorCode | null {
  if (value === 'SERVERTOOL_FOLLOWUP_FAILED' || value === 'SERVERTOOL_HANDLER_FAILED') {
    return value;
  }
  return null;
}

const NON_BLOCKING_PROTOCOL_LOG_THROTTLE_MS = 60_000;
const nonBlockingProtocolLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-hub-pipeline-orchestration-semantics-protocol.parse-failed');


function logNativeProtocolNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingProtocolLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_PROTOCOL_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingProtocolLogState.set(stage, now);
  console.warn(
    `[native-hub-pipeline-orchestration-semantics-protocol] ${stage} failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeProtocolNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
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
  } catch (error) {
    logNativeProtocolNonBlocking('safeStringify', error);
    return undefined;
  }
}

function parseString(raw: string): string | null {
  const parsed = parseJson('parseString', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  return typeof parsed === 'string' ? parsed : null;
}

function parseOptionalString(raw: string): string | undefined | null {
  const parsed = parseJson('parseOptionalString', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return undefined;
  }
  return typeof parsed === 'string' ? parsed : null;
}

function parseOrchestrationOutput(raw: string): HubPipelineOutput | null {
  const parsed = parseJson('parseOrchestrationOutput', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
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
}

function parseLibOutput(raw: string): HubPipelineLibOutput | null {
  const parsed = parseJson('parseLibOutput', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  const requestId = typeof row.requestId === 'string' ? row.requestId : '';
  const success = row.success === true;
  const effectPlan = row.effectPlan && typeof row.effectPlan === 'object' && !Array.isArray(row.effectPlan)
    ? row.effectPlan as Record<string, unknown>
    : null;
  const effects = Array.isArray(effectPlan?.effects) ? effectPlan.effects : null;
  const diagnostics = Array.isArray(row.diagnostics) ? row.diagnostics : null;
  if (!requestId || !effects || !diagnostics) {
    return null;
  }
  const output: HubPipelineLibOutput = {
    requestId,
    success,
    effectPlan: { effects: effects as Array<Record<string, unknown>> },
    diagnostics: diagnostics as Array<Record<string, unknown>>
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
}

export function executeHubPipelineWithNative(
  input: HubPipelineLibInput
): HubPipelineLibOutput {
  const capability = 'executeHubPipelineJson';
  const fail = (reason?: string) => failNativeRequired<HubPipelineLibOutput>(capability, reason);

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
    const parsed = parseLibOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function runHubPipelineLibWithNative(
  input: HubPipelineLibInput
): HubPipelineLibOutput {
  const capability = 'runHubPipelineLibJson';
  const fail = (reason?: string) => failNativeRequired<HubPipelineLibOutput>(capability, reason);

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
    const parsed = parseLibOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

function parseProviderResponseRuntimeEffectPlan(raw: string): ProviderResponseRuntimeEffectPlan | null {
  const parsed = parseJson('parseProviderResponseRuntimeEffectPlan', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  const streamPipe = row.streamPipe === null || row.streamPipe === undefined
    ? null
    : row.streamPipe && typeof row.streamPipe === 'object' && !Array.isArray(row.streamPipe)
      ? row.streamPipe as ProviderResponseRuntimeEffectPlan['streamPipe']
      : undefined;
  const runtimeStateWrite = row.runtimeStateWrite === null || row.runtimeStateWrite === undefined
    ? null
    : row.runtimeStateWrite && typeof row.runtimeStateWrite === 'object' && !Array.isArray(row.runtimeStateWrite)
      ? row.runtimeStateWrite as Record<string, unknown>
      : undefined;
  const stoplessMetadataCenterWrite =
    row.stoplessMetadataCenterWrite === null || row.stoplessMetadataCenterWrite === undefined
      ? null
      : row.stoplessMetadataCenterWrite && typeof row.stoplessMetadataCenterWrite === 'object' && !Array.isArray(row.stoplessMetadataCenterWrite)
        ? row.stoplessMetadataCenterWrite as Record<string, unknown>
        : undefined;
  if (
    streamPipe === undefined
    || runtimeStateWrite === undefined
    || stoplessMetadataCenterWrite === undefined
    || !Array.isArray(row.servertoolRuntimeActions)
  ) {
    return null;
  }
  return {
    streamPipe,
    runtimeStateWrite,
    stoplessMetadataCenterWrite,
    servertoolRuntimeActions: row.servertoolRuntimeActions as Array<Record<string, unknown>>,
  };
}

function parseProviderResponseServertoolRuntimeActionPlan(
  raw: string
): ProviderResponseServertoolRuntimeActionPlan | null {
  const parsed = parseJson('parseProviderResponseServertoolRuntimeActionPlan', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  if (!Array.isArray(row.executionPlans)) {
    return null;
  }
  const executionPlans: ProviderResponseServertoolRuntimeExecutionPlan[] = [];
  for (const entry of row.executionPlans) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const item = entry as Record<string, unknown>;
    if (!item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)) {
      return null;
    }
    if (item.projectionStage !== 'HubRespChatProcess03Governed') {
      return null;
    }
    if (typeof item.allowFollowup !== 'boolean') {
      return null;
    }
    executionPlans.push({
      payload: item.payload as Record<string, unknown>,
      projectionStage: item.projectionStage,
      allowFollowup: item.allowFollowup,
      ...(item.stopGateway && typeof item.stopGateway === 'object' && !Array.isArray(item.stopGateway)
        ? { stopGateway: item.stopGateway as Record<string, unknown> }
        : {})
    });
  }
  let error: ProviderResponseServertoolRuntimeErrorDescriptor | null | undefined;
  if (row.error === null || row.error === undefined) {
    error = null;
  } else if (row.error && typeof row.error === 'object' && !Array.isArray(row.error)) {
    const errorRecord = row.error as Record<string, unknown>;
    if (
      typeof errorRecord.message !== 'string'
      || typeof errorRecord.code !== 'string'
      || errorRecord.category !== 'INTERNAL_ERROR'
      || !errorRecord.details
      || typeof errorRecord.details !== 'object'
      || Array.isArray(errorRecord.details)
    ) {
      return null;
    }
    const code = readServertoolRuntimeErrorCode(errorRecord.code);
    if (!code) {
      return null;
    }
    error = {
      message: errorRecord.message,
      code,
      category: errorRecord.category,
      details: errorRecord.details as Record<string, unknown>
    };
  } else {
    return null;
  }
  return {
    executionPlans,
    error
  };
}

function parseProviderResponsePostServertoolEffectPlan(
  raw: string
): ProviderResponsePostServertoolEffectPlan | null {
  const parsed = parseJson('parseProviderResponsePostServertoolEffectPlan', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
    return null;
  }
  if (row.stage !== 'HubRespChatProcess03Governed' && row.stage !== 'unchanged') {
    return null;
  }
  if (typeof row.shouldProjectClientSemantic !== 'boolean') {
    return null;
  }
  return {
    payload: row.payload as Record<string, unknown>,
    stage: row.stage,
    shouldProjectClientSemantic: row.shouldProjectClientSemantic
  };
}

function parseProviderProtocolPlan(raw: string): ProviderProtocolPlan | null {
  const parsed = parseJson('parseProviderProtocolPlan', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.providerProtocol !== 'string' || !row.providerProtocol.trim()) {
    return null;
  }
  return { providerProtocol: row.providerProtocol.trim() };
}

function parseRecord(raw: string, stage: string): Record<string, unknown> | null {
  const parsed = parseJson(stage, raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

export function normalizeProviderResponseEffectPlanWithNative(
  effectPlan: { effects: Array<Record<string, unknown>> }
): ProviderResponseRuntimeEffectPlan {
  const capability = 'normalizeProviderResponseEffectPlanJson';
  const fail = (reason?: string) => failNativeRequired<ProviderResponseRuntimeEffectPlan>(capability, reason);
  const raw = callNativeJsonString(capability, effectPlan);
  return parseProviderResponseRuntimeEffectPlan(raw) ?? fail('invalid payload');
}

export function planProviderResponseServertoolRuntimeActionsWithNative(input: {
  servertoolRuntimeActions: Array<Record<string, unknown>>;
}): ProviderResponseServertoolRuntimeActionPlan {
  const capability = 'planProviderResponseServertoolRuntimeActionsJson';
  const fail = (reason?: string) => failNativeRequired<ProviderResponseServertoolRuntimeActionPlan>(capability, reason);
  const raw = callNativeJsonString(capability, input);
  return parseProviderResponseServertoolRuntimeActionPlan(raw) ?? fail('invalid payload');
}

export function resolveProviderResponsePostServertoolEffectWithNative(input: {
  actionPlan: ProviderResponseServertoolRuntimeActionPlan;
  currentPayload: Record<string, unknown>;
  orchestrationPayload: Record<string, unknown>;
  orchestrationExecuted: boolean;
}): ProviderResponsePostServertoolEffectPlan {
  const capability = 'resolveProviderResponsePostServertoolEffectJson';
  const fail = (reason?: string) => failNativeRequired<ProviderResponsePostServertoolEffectPlan>(capability, reason);
  const raw = callNativeJsonString(capability, input);
  return parseProviderResponsePostServertoolEffectPlan(raw) ?? fail('invalid payload');
}

export function resolveProviderProtocolWithNative(input: {
  metadataCenterSnapshot: Record<string, unknown> | null;
}): ProviderProtocolPlan {
  const capability = 'resolveProviderProtocolJson';
  const fail = (reason?: string) => failNativeRequired<ProviderProtocolPlan>(capability, reason);
  const raw = callNativeJsonString(capability, input);
  return parseProviderProtocolPlan(raw) ?? fail('invalid payload');
}

export function projectMetadataWritePlanToRuntimeControlWithNative(input: {
  plan: Record<string, unknown>;
}): Record<string, unknown> {
  const capability = 'projectMetadataWritePlanToRuntimeControlJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  const raw = callNativeJsonString(capability, input);
  return parseRecord(raw, 'parseMetadataWritePlanRuntimeControlProjection') ?? fail('invalid payload');
}

export function buildRequestStageMetadataDispatchWithNative(input: {
  sourceMetadata: Record<string, unknown>;
  requestTruth: Record<string, unknown>;
  continuationContext: Record<string, unknown>;
  runtimeControl: Record<string, unknown>;
  providerProtocol: string;
  excludedProviderKeys?: unknown;
}): RequestStageMetadataDispatchPlan {
  const capability = 'buildRequestStageMetadataDispatchJson';
  const fail = (reason?: string) => failNativeRequired<RequestStageMetadataDispatchPlan>(capability, reason);
  const parsed = parseRecord(callNativeJsonString(capability, input), 'parseRequestStageMetadataDispatch');
  if (!parsed || !parsed.metadata || typeof parsed.metadata !== 'object' || Array.isArray(parsed.metadata)) {
    return fail('invalid payload');
  }
  const snapshot = parsed.metadataCenterSnapshot;
  if (snapshot !== undefined && snapshot !== null && (typeof snapshot !== 'object' || Array.isArray(snapshot))) {
    return fail('invalid payload');
  }
  return {
    metadata: parsed.metadata as Record<string, unknown>,
    metadataCenterSnapshot: snapshot as Record<string, unknown> | null | undefined,
  };
}

export function runHubPipelineOrchestrationWithNative(input: HubPipelineInput): HubPipelineOutput {
  const capability = 'runHubPipelineJson';
  const fail = (reason?: string) => failNativeRequired<HubPipelineOutput>(capability, reason);
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const inputJson = safeStringify(input);
  if (!inputJson) return fail('json stringify failed');
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) return fail('empty result');
    return parseOrchestrationOutput(raw) ?? fail('invalid payload');
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error ?? 'unknown'));
  }
}

function callNativeString(capability: string, args: unknown[]): string {
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  try {
    const raw = fn(...args);
    if (typeof raw !== 'string') return fail('non-string result');
    return raw;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error ?? 'unknown'));
  }
}

function callNativeJsonString(capability: string, value: unknown): string {
  const inputJson = safeStringify(value);
  if (!inputJson) return failNativeRequired<string>(capability, 'json stringify failed');
  return callNativeString(capability, [inputJson]);
}

function stringifyNativeArgument(capability: string, value: unknown): string {
  const inputJson = safeStringify(value);
  return inputJson ?? failNativeRequired<string>(capability, 'json stringify failed');
}

export function normalizeHubEndpointWithNative(endpoint: string): string {
  const capability = 'normalizeHubEndpointJson';
  return parseString(callNativeString(capability, [endpoint])) ?? failNativeRequired<string>(capability, 'invalid payload');
}

export function extractModelHintFromMetadataWithNative(metadata: Record<string, unknown>): string | undefined {
  const capability = 'extractModelHintFromMetadataJson';
  const parsed = parseOptionalString(callNativeJsonString(capability, metadata));
  return parsed === null ? failNativeRequired<string | undefined>(capability, 'invalid payload') : parsed;
}

export function resolveSseProtocolWithNative(metadata: Record<string, unknown>, providerProtocol: string): string {
  const capability = 'resolveSseProtocolJson';
  return parseString(callNativeString(capability, [stringifyNativeArgument(capability, metadata), providerProtocol]))
    ?? failNativeRequired<string>(capability, 'invalid payload');
}
