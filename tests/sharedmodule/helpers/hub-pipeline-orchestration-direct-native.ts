import {
  failNativeRequired,
  isNativeDisabledByEnv,
  loadNativeRouterHotpathBindingForInternalUse,
  stringifyNativePayloadForError
} from './native-router-hotpath-loader.js';

// feature_id: hub.request_stage_pipeline_bridge
// Rust owner symbols: run_hub_pipeline_lib_json, build_request_stage_metadata_dispatch_json,
// build_request_stage_native_result_plan_json, build_request_stage_hub_pipeline_result_json.

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

export type ProviderResponseOutboundEffectMaterialization = {
  rawPayload: Record<string, unknown>;
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
  diagnosticInput: {
    requestId: string;
    diagnostics: Array<Record<string, unknown>>;
  };
};

export type ProviderProtocolPlan = {
  providerProtocol: string;
};

export type RequestStageMetadataDispatchPlan = {
  metadata: Record<string, unknown>;
  metadataCenterSnapshot?: Record<string, unknown> | null;
};

export type HubPipelineMaterializedRequestPlan = {
  endpoint: string;
  entryEndpoint: string;
  providerProtocol: string;
  metadata: Record<string, unknown>;
  metadataCenterSnapshot?: Record<string, unknown> | null;
  processMode: 'chat';
  direction: 'request' | 'response';
  stage: 'inbound' | 'outbound';
  stream: boolean;
  disableSnapshots: boolean;
  hubEntryMode?: 'chat_process';
  policyOverride?: Record<string, unknown>;
  shadowCompare?: Record<string, unknown>;
};

export type ProviderResponseMetadataSnapshotPlan = {
  metadataCenterSnapshot?: Record<string, unknown> | null;
};

export type RequestStageRuntimeControlWritePlan = {
  runtimeControl?: Record<string, unknown> | null;
};

export type RequestStageNativeResultPlan = {
  ok: boolean;
  providerPayload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  diagnostics?: Array<Record<string, unknown>>;
  standardizedRequest?: Record<string, unknown>;
  error?: {
    code?: string;
    message: string;
    status?: number;
    statusCode?: number;
    details?: unknown;
  };
};

export type RequestStageHubPipelineResultPlan = {
  requestId: string;
  providerPayload?: Record<string, unknown>;
  standardizedRequest?: Record<string, unknown>;
  entryOriginRequest?: Record<string, unknown>;
  processedRequest?: Record<string, unknown>;
  routingDecision?: Record<string, unknown>;
  routingDiagnostics?: Record<string, unknown>;
  target?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  nodeResults: Array<Record<string, unknown>>;
};

export type MetadataWritePlanRuntimeControlWritePlan = {
  runtimeControl?: Record<string, unknown> | null;
};

const JSON_PARSE_FAILED = Symbol('native-hub-pipeline-orchestration-semantics-protocol.parse-failed');


function logNativeProtocolNonBlocking(stage: string, error: unknown): void {
  console.warn(
    `[native-hub-pipeline-orchestration-test-helper] ${stage} failed (non-blocking): ${stringifyNativePayloadForError(error)}`
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
    if (typeof raw !== 'string') {
      return fail(stringifyNativePayloadForError(raw) ?? 'non-string result');
    }
    if (!raw) {
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
    if (typeof raw !== 'string') {
      return fail(stringifyNativePayloadForError(raw) ?? 'non-string result');
    }
    if (!raw) {
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

export function materializeProviderResponseOutboundEffectPlanWithNative(
  nativePlan: HubPipelineLibOutput
): ProviderResponseOutboundEffectMaterialization {
  const capability = 'materializeProviderResponseOutboundEffectPlanJson';
  const fail = (reason?: string) => failNativeRequired<ProviderResponseOutboundEffectMaterialization>(capability, reason);
  const parsed = parseRecord(callNativeJsonString(capability, nativePlan), 'parseProviderResponseOutboundEffectMaterialization');
  const rawPayload = parsed?.rawPayload;
  const diagnosticInput = parsed?.diagnosticInput;
  const runtimeEffectsRaw = parsed?.runtimeEffects;
  if (
    !rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)
    || !diagnosticInput || typeof diagnosticInput !== 'object' || Array.isArray(diagnosticInput)
    || !runtimeEffectsRaw || typeof runtimeEffectsRaw !== 'object' || Array.isArray(runtimeEffectsRaw)
  ) {
    return fail('invalid payload');
  }
  const runtimeEffects = parseProviderResponseRuntimeEffectPlan(JSON.stringify(runtimeEffectsRaw));
  if (!runtimeEffects) {
    return fail('invalid payload');
  }
  const diagnosticRecord = diagnosticInput as Record<string, unknown>;
  if (typeof diagnosticRecord.requestId !== 'string' || !Array.isArray(diagnosticRecord.diagnostics)) {
    return fail('invalid payload');
  }
  return {
    rawPayload: rawPayload as Record<string, unknown>,
    runtimeEffects,
    diagnosticInput: {
      requestId: diagnosticRecord.requestId,
      diagnostics: diagnosticRecord.diagnostics as Array<Record<string, unknown>>,
    },
  };
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

export function projectMetadataWritePlanToRuntimeControlWritePlanWithNative(input: {
  plan: Record<string, unknown>;
}): MetadataWritePlanRuntimeControlWritePlan {
  const capability = 'projectMetadataWritePlanToRuntimeControlWritePlanJson';
  const fail = (reason?: string) => failNativeRequired<MetadataWritePlanRuntimeControlWritePlan>(capability, reason);
  const parsed = parseRecord(callNativeJsonString(capability, input), 'parseMetadataWritePlanRuntimeControlWritePlanProjection');
  if (!parsed) {
    return fail('invalid payload');
  }
  const runtimeControl = parsed.runtimeControl;
  if (runtimeControl !== undefined && runtimeControl !== null && (typeof runtimeControl !== 'object' || Array.isArray(runtimeControl))) {
    return fail('invalid payload');
  }
  return {
    runtimeControl: runtimeControl as Record<string, unknown> | null | undefined,
  };
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

export function buildHubPipelineMaterializedRequestPlanWithNative(input: {
  endpoint: string;
  providerProtocol: string;
  metadata: Record<string, unknown>;
  metadataCenterSnapshot?: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  payloadStream: boolean;
}): HubPipelineMaterializedRequestPlan {
  const capability = 'buildHubPipelineMaterializedRequestPlanJson';
  const fail = (reason?: string) => failNativeRequired<HubPipelineMaterializedRequestPlan>(capability, reason);
  const parsed = parseRecord(callNativeJsonString(capability, input), 'parseHubPipelineMaterializedRequestPlan');
  if (!parsed || !parsed.metadata || typeof parsed.metadata !== 'object' || Array.isArray(parsed.metadata)) {
    return fail('invalid payload');
  }
  const endpoint = typeof parsed.endpoint === 'string' ? parsed.endpoint : '';
  const entryEndpoint = typeof parsed.entryEndpoint === 'string' ? parsed.entryEndpoint : '';
  const providerProtocol = typeof parsed.providerProtocol === 'string' ? parsed.providerProtocol : '';
  const processMode = parsed.processMode;
  const direction = parsed.direction;
  const stage = parsed.stage;
  if (!endpoint || !entryEndpoint || !providerProtocol || processMode !== 'chat') {
    return fail('invalid payload');
  }
  if (direction !== 'request' && direction !== 'response') {
    return fail('invalid payload');
  }
  if (stage !== 'inbound' && stage !== 'outbound') {
    return fail('invalid payload');
  }
  if (typeof parsed.stream !== 'boolean' || typeof parsed.disableSnapshots !== 'boolean') {
    return fail('invalid payload');
  }
  const metadataCenterSnapshot = parsed.metadataCenterSnapshot;
  if (metadataCenterSnapshot !== undefined && metadataCenterSnapshot !== null && (typeof metadataCenterSnapshot !== 'object' || Array.isArray(metadataCenterSnapshot))) {
    return fail('invalid payload');
  }
  const hubEntryMode = parsed.hubEntryMode === 'chat_process' ? 'chat_process' : undefined;
  if (parsed.hubEntryMode !== undefined && hubEntryMode === undefined) {
    return fail('invalid payload');
  }
  const policyOverride = parsed.policyOverride;
  if (policyOverride !== undefined && (typeof policyOverride !== 'object' || policyOverride === null || Array.isArray(policyOverride))) {
    return fail('invalid payload');
  }
  const shadowCompare = parsed.shadowCompare;
  if (shadowCompare !== undefined && (typeof shadowCompare !== 'object' || shadowCompare === null || Array.isArray(shadowCompare))) {
    return fail('invalid payload');
  }
  return {
    endpoint,
    entryEndpoint,
    providerProtocol,
    metadata: parsed.metadata as Record<string, unknown>,
    ...(metadataCenterSnapshot ? { metadataCenterSnapshot: metadataCenterSnapshot as Record<string, unknown> } : {}),
    processMode,
    direction,
    stage,
    stream: parsed.stream,
    disableSnapshots: parsed.disableSnapshots,
    ...(hubEntryMode ? { hubEntryMode } : {}),
    ...(policyOverride ? { policyOverride: policyOverride as Record<string, unknown> } : {}),
    ...(shadowCompare ? { shadowCompare: shadowCompare as Record<string, unknown> } : {}),
  };
}

export function buildProviderResponseMetadataSnapshotWithNative(input: {
  hasBoundMetadataCenter: boolean;
  requestTruth: Record<string, unknown>;
  continuationContext: Record<string, unknown>;
  runtimeControl: Record<string, unknown>;
  directMetadataCenterSnapshot?: Record<string, unknown> | null;
  nestedMetadataCenterSnapshot?: Record<string, unknown> | null;
}): ProviderResponseMetadataSnapshotPlan {
  const capability = 'buildProviderResponseMetadataSnapshotJson';
  const fail = (reason?: string) => failNativeRequired<ProviderResponseMetadataSnapshotPlan>(capability, reason);
  const parsed = parseRecord(callNativeJsonString(capability, input), 'parseProviderResponseMetadataSnapshot');
  if (!parsed) {
    return fail('invalid payload');
  }
  const snapshot = parsed.metadataCenterSnapshot;
  if (snapshot !== undefined && snapshot !== null && (typeof snapshot !== 'object' || Array.isArray(snapshot))) {
    return fail('invalid payload');
  }
  return {
    metadataCenterSnapshot: snapshot as Record<string, unknown> | null | undefined,
  };
}

export function buildRequestStageRuntimeControlWritePlanWithNative(input: {
  outputMetadata: Record<string, unknown>;
}): RequestStageRuntimeControlWritePlan {
  const capability = 'buildRequestStageRuntimeControlWritePlanJson';
  const fail = (reason?: string) => failNativeRequired<RequestStageRuntimeControlWritePlan>(capability, reason);
  const parsed = parseRecord(callNativeJsonString(capability, input), 'parseRequestStageRuntimeControlWritePlan');
  if (!parsed) {
    return fail('invalid payload');
  }
  const runtimeControl = parsed.runtimeControl;
  if (runtimeControl !== undefined && runtimeControl !== null && (typeof runtimeControl !== 'object' || Array.isArray(runtimeControl))) {
    return fail('invalid payload');
  }
  return {
    runtimeControl: runtimeControl as Record<string, unknown> | null | undefined,
  };
}

export function buildRequestStageNativeResultPlanWithNative(input: {
  nativePlan: HubPipelineLibOutput;
  entryMode: 'request_stage' | 'chat_process';
}): RequestStageNativeResultPlan {
  const capability = 'buildRequestStageNativeResultPlanJson';
  const fail = (reason?: string) => failNativeRequired<RequestStageNativeResultPlan>(capability, reason);
  const parsed = parseRecord(callNativeJsonString(capability, input), 'parseRequestStageNativeResultPlan');
  if (!parsed) {
    return fail('invalid payload');
  }
  if (parsed.ok === false) {
    const error = parsed.error;
    if (!error || typeof error !== 'object' || Array.isArray(error)) {
      return fail('invalid payload');
    }
    const errorRecord = error as Record<string, unknown>;
    const message = typeof errorRecord.message === 'string' && errorRecord.message.trim()
      ? errorRecord.message.trim()
      : '';
    if (!message) {
      return fail('invalid payload');
    }
    return {
      ok: false,
      error: {
        ...(typeof errorRecord.code === 'string' ? { code: errorRecord.code } : {}),
        message,
        ...(typeof errorRecord.status === 'number' ? { status: errorRecord.status } : {}),
        ...(typeof errorRecord.statusCode === 'number' ? { statusCode: errorRecord.statusCode } : {}),
        ...(Object.prototype.hasOwnProperty.call(errorRecord, 'details') ? { details: errorRecord.details } : {}),
      },
    };
  }
  if (parsed.ok !== true) {
    return fail('invalid payload');
  }
  if (!parsed.providerPayload || typeof parsed.providerPayload !== 'object' || Array.isArray(parsed.providerPayload)) {
    return fail('invalid payload');
  }
  const metadata = parsed.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return fail('invalid payload');
  }
  if (!Array.isArray(parsed.diagnostics)) {
    return fail('invalid payload');
  }
  return {
    ok: true,
    providerPayload: parsed.providerPayload as Record<string, unknown>,
    metadata: metadata as Record<string, unknown>,
    diagnostics: parsed.diagnostics as Array<Record<string, unknown>>,
    ...(parsed.standardizedRequest && typeof parsed.standardizedRequest === 'object' && !Array.isArray(parsed.standardizedRequest)
      ? { standardizedRequest: parsed.standardizedRequest as Record<string, unknown> }
      : {}),
  };
}

export function buildRequestStageHubPipelineResultWithNative(input: {
  requestId: string;
  resultPlan: RequestStageNativeResultPlan;
  entryMode: 'request_stage' | 'chat_process';
}): RequestStageHubPipelineResultPlan {
  const capability = 'buildRequestStageHubPipelineResultJson';
  const fail = (reason?: string) => failNativeRequired<RequestStageHubPipelineResultPlan>(capability, reason);
  const parsed = parseRecord(callNativeJsonString(capability, input), 'parseRequestStageHubPipelineResult');
  if (!parsed) {
    return fail('invalid payload');
  }
  if (typeof parsed.requestId !== 'string' || !parsed.requestId.trim()) {
    return fail('invalid payload');
  }
  if (!parsed.metadata || typeof parsed.metadata !== 'object' || Array.isArray(parsed.metadata)) {
    return fail('invalid payload');
  }
  if (!Array.isArray(parsed.nodeResults)) {
    return fail('invalid payload');
  }
  return parsed as RequestStageHubPipelineResultPlan;
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
  let raw: unknown;
  try {
    raw = fn(...args);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error ?? 'unknown'));
  }
  if (typeof raw !== 'string') {
    return fail(stringifyNativePayloadForError(raw) ?? 'non-string result');
  }
  return raw;
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
