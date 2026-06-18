import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../handlers/types.js';
// feature_id: server.servertool_followup_dispatch_surface
import { asRecord } from '../provider-utils.js';
import { isClientDisconnectAbortError } from '../executor-provider.js';
import { runClientInjectionFlowBeforeReenter } from './client-injection-flow.js';
import { buildServerToolNestedRequestMetadata } from './servertool-followup-metadata.js';
import { importCoreDist } from '../../../../modules/llmswitch/bridge/module-loader.js';
import { readResponsesResponseIdFromHttp } from '../../../../modules/llmswitch/bridge/responses-request-bridge.js';
import {
  awaitNestedExecutionWithFailFast,
  getNestedFollowupAbortSignal,
  throwIfNestedFollowupAborted
} from './servertool-followup-fail-fast.js';
import { preserveLiveClientAbortCarriers } from './request-executor-client-abort-block.js';
import {
  readRuntimeControlProjection,
  readRuntimeRequestTruthIdentifiers
} from '../metadata-center/request-truth-readers.js';
import { MetadataCenter } from '../metadata-center/metadata-center.js';
import type { MetadataCenterWriter } from '../metadata-center/metadata-center-types.js';
import {
  recordErrorActionBackoff,
  waitErrorActionBackoffWithGate
} from './request-executor-error-action-queue.js';

type NativeHubPipelineSemanticMappersModule = {
  normalizeServertoolFollowupPayloadShapeWithNative?: (entryEndpoint: string, payload: Record<string, unknown>) => Record<string, unknown>;
};

let cachedNativeHubPipelineSemanticMappers: NativeHubPipelineSemanticMappersModule | null = null;

async function getNativeHubPipelineSemanticMappers(): Promise<NativeHubPipelineSemanticMappersModule> {
  if (!cachedNativeHubPipelineSemanticMappers) {
    cachedNativeHubPipelineSemanticMappers = await importCoreDist<NativeHubPipelineSemanticMappersModule>(
      'native/router-hotpath/native-hub-pipeline-semantic-mappers'
    );
  }
  return cachedNativeHubPipelineSemanticMappers;
}

type ServerToolNestedExecute = (input: PipelineExecutionInput) => Promise<PipelineExecutionResult>;

type BuildNestedMetadataLogger = (error: unknown, details: {
  requestId: string;
  entryEndpoint: string;
  mode: 'reenter' | 'client_inject';
}) => void;

async function normalizeFollowupPayloadShapeWithNative(entryEndpoint: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const mod = await getNativeHubPipelineSemanticMappers();
  const fn = mod.normalizeServertoolFollowupPayloadShapeWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[servertool] normalizeServertoolFollowupPayloadShapeWithNative unavailable');
  }
  return fn(entryEndpoint, payload);
}

const SAME_PROVIDER_FOLLOWUP_MAX_ATTEMPTS = 3;

const SERVERTOOL_FOLLOWUP_RUNTIME_CONTROL_WRITER: MetadataCenterWriter = {
  module: 'src/server/runtime/http-server/executor/servertool-followup-dispatch.ts',
  symbol: 'writeFollowupRuntimeControlToMetadata',
  stage: 'ServertoolFollowupRuntimeControlBound'
};

type FollowupRuntimeControl = {
  serverToolFollowup: boolean;
  followupSource?: string;
  stoplessGoalStatus?: string;
};


type ResponsesConversationModule = {
  captureResponsesRequestContext?: (args: {
    requestId: string;
    payload: Record<string, unknown>;
    context: Record<string, unknown>;
    sessionId?: string;
    conversationId?: string;
    entryKind?: 'responses' | 'chat' | 'messages';
    providerKey?: string;
    matchedPort?: number;
    routingPolicyGroup?: string;
    routeHint?: string;
  }) => void;
  rebindResponsesConversationRequestId?: (oldId: string, newId: string) => void;
};

let cachedResponsesConversationModule: ResponsesConversationModule | null = null;

async function getResponsesConversationModule(): Promise<ResponsesConversationModule> {
  if (!cachedResponsesConversationModule) {
    cachedResponsesConversationModule = await importCoreDist<ResponsesConversationModule>('conversion/shared/responses-conversation-store');
  }
  return cachedResponsesConversationModule;
}

async function captureNestedResponsesRequestContext(input: PipelineExecutionInput): Promise<void> {
  const entryEndpoint = typeof input.entryEndpoint === 'string' ? input.entryEndpoint.toLowerCase() : '';
  if (!entryEndpoint.includes('/v1/responses')) {
    return;
  }
  const body = asObjectBody(input.body);
  if (!body) {
    return;
  }
  const mod = await getResponsesConversationModule();
  if (typeof mod.captureResponsesRequestContext !== 'function') {
    throw new Error('[servertool] responses followup context capture helper unavailable');
  }
  const metadata = asRecord(input.metadata) ?? {};
  const requestTruth = readRuntimeRequestTruthIdentifiers(metadata);
  const context = {
    requestId: input.requestId,
    isResponsesPayload: true,
    input: Array.isArray(body.input) ? body.input : [],
    parameters: body.parameters && typeof body.parameters === 'object' && !Array.isArray(body.parameters)
      ? body.parameters as Record<string, unknown>
      : undefined
  };
  mod.captureResponsesRequestContext({
    requestId: input.requestId,
    payload: body,
    context,
    sessionId: requestTruth.sessionId,
    conversationId: requestTruth.conversationId,
    entryKind: 'responses',
    routeHint: typeof metadata.routeHint === 'string' ? metadata.routeHint : undefined
  });
}

async function rebindNestedResponsesContextToResponseId(input: PipelineExecutionInput, body: Record<string, unknown> | undefined): Promise<void> {
  const entryEndpoint = typeof input.entryEndpoint === 'string' ? input.entryEndpoint.toLowerCase() : '';
  if (!entryEndpoint.includes('/v1/responses')) return;
  const responseId = readResponsesResponseIdFromHttp(body);
  if (!responseId || responseId === input.requestId) return;
  const mod = await getResponsesConversationModule();
  if (typeof mod.rebindResponsesConversationRequestId !== 'function') {
    throw new Error('[servertool] responses followup context rebind helper unavailable');
  }
  mod.rebindResponsesConversationRequestId(input.requestId, responseId);
}

function readForcedProviderKey(metadata?: Record<string, unknown>): string | undefined {
  const raw = metadata?.__shadowCompareForcedProviderKey;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

function readNumericStatusFromError(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  const statusCandidates = [record.status, record.statusCode];
  for (const candidate of statusCandidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return Math.floor(candidate);
    }
  }
  return undefined;
}

function isTerminalFollowupDispatchError(error: unknown): boolean {
  const status = readNumericStatusFromError(error);
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return true;
  }
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return false;
  }
  const record = error as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code.trim().toLowerCase() : '';
  const upstreamCode =
    typeof record.upstreamCode === 'string' ? record.upstreamCode.trim().toLowerCase() : '';
  return code === 'provider_not_available' || upstreamCode === 'provider_not_available';
}


function cloneStringHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return undefined;
  }
  const cloned: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof headerValue !== 'string' || !headerValue.trim()) {
      continue;
    }
    cloned[headerName] = headerValue;
  }
  return Object.keys(cloned).length ? cloned : undefined;
}

function stripSseRequestHeadersForNonStreamingFollowup(
  headers: Record<string, string> | undefined,
  body: Record<string, unknown> | undefined
): Record<string, string> | undefined {
  if (!headers) {
    return headers;
  }
  const stream = body?.stream;
  if (stream !== false) {
    return headers;
  }
  const next: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    const key = headerName.trim().toLowerCase();
    const value = headerValue.trim().toLowerCase();
    if (key === 'accept' && value.includes('text/event-stream')) {
      continue;
    }
    next[headerName] = headerValue;
  }
  return Object.keys(next).length ? next : undefined;
}

function asObjectBody(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cloneJsonRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function clonePipelineInputForRetry(input: PipelineExecutionInput): PipelineExecutionInput {
  const cloned = cloneJsonRecord(input);
  const sourceMetadata =
    input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? (input.metadata as Record<string, unknown>)
      : undefined;
  const targetMetadata =
    cloned.metadata && typeof cloned.metadata === 'object' && !Array.isArray(cloned.metadata)
      ? (cloned.metadata as Record<string, unknown>)
      : undefined;
  preserveLiveClientAbortCarriers({ source: sourceMetadata, target: targetMetadata });
  const sourceMetadataCenter = MetadataCenter.read(sourceMetadata);
  if (sourceMetadataCenter && targetMetadata) {
    MetadataCenter.bind(targetMetadata, sourceMetadataCenter);
  }
  return cloned;
}

function readManagedStoplessGoalStatusFromSemantics(
  requestSemantics: Record<string, unknown> | undefined
): string | undefined {
  const statusCandidate =
    requestSemantics?.stoplessGoalState && typeof requestSemantics.stoplessGoalState === 'object' && !Array.isArray(requestSemantics.stoplessGoalState)
      ? (requestSemantics.stoplessGoalState as Record<string, unknown>).status
      : undefined;
  const normalized = typeof statusCandidate === 'string' ? statusCandidate.trim().toLowerCase() : '';
  return normalized || undefined;
}

function readBooleanFlag(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

function readFollowupMarkerFromMetadata(
  metadata?: Record<string, unknown>
): FollowupRuntimeControl {
  const runtimeControl = MetadataCenter.read(metadata)?.readRuntimeControl();
  const rt =
    metadata?.__rt && typeof metadata.__rt === 'object' && !Array.isArray(metadata.__rt)
      ? (metadata.__rt as Record<string, unknown>)
      : undefined;
  const sourceCandidate = [
    runtimeControl?.serverToolFollowupSource,
    metadata?.clientInjectSource,
    rt?.clientInjectSource,
    rt?.serverToolFollowupSource
  ].find((value) => typeof value === 'string' && value.trim().length > 0);
  const stoplessGoalStatus = [
    runtimeControl?.stoplessGoalStatus,
    rt?.stoplessGoalStatus
  ].find((value) => typeof value === 'string' && value.trim().length > 0);

  return {
    serverToolFollowup: [
      runtimeControl?.serverToolFollowup,
      metadata?.serverToolFollowup,
      metadata?.isServerToolFollowup,
      rt?.serverToolFollowup
    ].some(readBooleanFlag),
    ...(typeof stoplessGoalStatus === 'string' && stoplessGoalStatus.trim()
      ? { stoplessGoalStatus: stoplessGoalStatus.trim().toLowerCase() }
      : {}),
    ...(typeof sourceCandidate === 'string' && sourceCandidate.trim()
      ? { followupSource: sourceCandidate.trim() }
      : {})
  };
}

function mergeFollowupRuntimeControl(
  primary: FollowupRuntimeControl,
  secondary: FollowupRuntimeControl
): FollowupRuntimeControl {
  return {
    serverToolFollowup:
      primary.serverToolFollowup
      || secondary.serverToolFollowup
      || Boolean(primary.followupSource)
      || Boolean(secondary.followupSource),
    followupSource: primary.followupSource ?? secondary.followupSource,
    stoplessGoalStatus: primary.stoplessGoalStatus ?? secondary.stoplessGoalStatus
  };
}

function writeFollowupRuntimeControlToMetadata(
  metadata: Record<string, unknown>,
  control: FollowupRuntimeControl
): void {
  const center = MetadataCenter.attach(metadata);
  if (control.serverToolFollowup) {
    MetadataCenter.attach(metadata).writeRuntimeControl(
      'serverToolFollowup',
      true,
      SERVERTOOL_FOLLOWUP_RUNTIME_CONTROL_WRITER,
      'servertool-followup-dispatch'
    );
  }
  if (control.followupSource) {
    center.writeRuntimeControl(
      'serverToolFollowupSource',
      control.followupSource,
      SERVERTOOL_FOLLOWUP_RUNTIME_CONTROL_WRITER,
      'servertool-followup-dispatch'
    );
  }
  if (control.stoplessGoalStatus) {
    center.writeRuntimeControl(
      'stoplessGoalStatus',
      control.stoplessGoalStatus,
      SERVERTOOL_FOLLOWUP_RUNTIME_CONTROL_WRITER,
      'servertool-followup-dispatch'
    );
  }
  const rt =
    metadata.__rt && typeof metadata.__rt === 'object' && !Array.isArray(metadata.__rt)
      ? (metadata.__rt as Record<string, unknown>)
      : {};
  metadata.__rt = {
    ...rt,
    ...(control.serverToolFollowup ? { serverToolFollowup: true } : {}),
    ...(control.followupSource
      ? {
          clientInjectSource: control.followupSource,
          serverToolFollowupSource: control.followupSource
        }
      : {}),
    ...(control.stoplessGoalStatus ? { stoplessGoalStatus: control.stoplessGoalStatus } : {})
  };
}

function writeStopMessageEnabledRuntimeControl(
  metadata: Record<string, unknown>,
  enabled: boolean,
  reason: string
): void {
  MetadataCenter.attach(metadata).writeRuntimeControl(
    'stopMessageEnabled',
    enabled,
    SERVERTOOL_FOLLOWUP_RUNTIME_CONTROL_WRITER,
    reason
  );
}

function materializeFollowupRequestSemantics(args: {
  requestSemantics?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  baseMetadata?: Record<string, unknown>;
}): {
  requestSemantics?: Record<string, unknown>;
  runtimeControl: FollowupRuntimeControl;
} {
  const runtimeControl = mergeFollowupRuntimeControl(
    readFollowupMarkerFromMetadata(args.metadata),
    readFollowupMarkerFromMetadata(args.baseMetadata)
  );
  const stoplessGoalStatus =
    runtimeControl.stoplessGoalStatus
    ?? readManagedStoplessGoalStatusFromSemantics(args.requestSemantics);

  if (!args.requestSemantics) {
    return {
      runtimeControl: {
        ...runtimeControl,
        ...(stoplessGoalStatus ? { stoplessGoalStatus } : {})
      }
    };
  }

  const nextSemantics = cloneJsonRecord((args.requestSemantics ?? {}) as Record<string, unknown>);
  delete nextSemantics['__' + 'routecodex'];
  return {
    requestSemantics: nextSemantics,
    runtimeControl: {
      ...runtimeControl,
      ...(stoplessGoalStatus ? { stoplessGoalStatus } : {})
    }
  };
}


function stripResponsesOnlyRequestSettings(
  body: Record<string, unknown>,
  isFollowup: boolean
): Record<string, unknown> {
  if (!isFollowup) {
    return body;
  }
  const out: Record<string, unknown> = { ...body };
  delete out.max_tokens;
  delete out.max_output_tokens;
  delete out.parallel_tool_calls;
  delete out.reasoning;

  const semantics =
    out.semantics && typeof out.semantics === 'object' && !Array.isArray(out.semantics)
      ? ({ ...(out.semantics as Record<string, unknown>) } as Record<string, unknown>)
      : undefined;
  const responses =
    semantics?.responses && typeof semantics.responses === 'object' && !Array.isArray(semantics.responses)
      ? ({ ...(semantics.responses as Record<string, unknown>) } as Record<string, unknown>)
      : undefined;
  const requestParameters =
    responses?.requestParameters && typeof responses.requestParameters === 'object' && !Array.isArray(responses.requestParameters)
      ? ({ ...(responses.requestParameters as Record<string, unknown>) } as Record<string, unknown>)
      : undefined;
  if (requestParameters) {
    delete requestParameters.model;
    delete requestParameters.max_tokens;
    delete requestParameters.max_output_tokens;
    delete requestParameters.parallel_tool_calls;
    delete requestParameters.reasoning;
    responses!.requestParameters = requestParameters;
    semantics!.responses = responses!;
    out.semantics = semantics!;
  }
  return out;
}

function stripResponsesOnlyRequestSemantics(
  requestSemantics: Record<string, unknown> | undefined,
  isFollowup: boolean
): Record<string, unknown> | undefined {
  if (!requestSemantics || !isFollowup) {
    return requestSemantics;
  }
  const wrapped = stripResponsesOnlyRequestSettings({ semantics: requestSemantics }, isFollowup);
  return wrapped.semantics && typeof wrapped.semantics === 'object' && !Array.isArray(wrapped.semantics)
    ? (wrapped.semantics as Record<string, unknown>)
    : requestSemantics;
}

async function cloneNestedBodyWithSemantics(
  entryEndpoint: string,
  body: Record<string, unknown> | undefined,
  requestSemantics: Record<string, unknown> | undefined,
  isFollowup: boolean
): Promise<Record<string, unknown>> {
  let out = body ? { ...body } : {};
  out = stripResponsesOnlyRequestSettings(out, isFollowup);
  out = await normalizeFollowupPayloadShapeWithNative(entryEndpoint, out);
  out = stripResponsesOnlyRequestSettings(out, isFollowup);
  return out;
}

function extractNestedPipelineErrorMessage(body: Record<string, unknown> | undefined, status?: number): string {
  const errorRecord = body && typeof body.error === 'object' && body.error && !Array.isArray(body.error)
    ? (body.error as Record<string, unknown>)
    : undefined;
  const message =
    typeof errorRecord?.message === 'string' && errorRecord.message.trim()
      ? errorRecord.message.trim()
      : undefined;
  if (message) {
    return message;
  }
  if (typeof status === 'number' && Number.isFinite(status)) {
    return `ServerTool nested followup request failed with HTTP ${status}`;
  }
  return 'ServerTool nested followup request failed';
}

function throwIfNestedPipelineReturnedError(result: PipelineExecutionResult): void {
  const status = typeof result.status === 'number' && Number.isFinite(result.status)
    ? Math.floor(result.status)
    : undefined;
  const body =
    result.body && typeof result.body === 'object' && !Array.isArray(result.body)
      ? (result.body as Record<string, unknown>)
      : undefined;
  const errorRecord = body && typeof body.error === 'object' && body.error && !Array.isArray(body.error)
    ? (body.error as Record<string, unknown>)
    : undefined;
  const hasHttpErrorStatus = typeof status === 'number' && status >= 400;
  if (!hasHttpErrorStatus && !errorRecord) {
    return;
  }

  const message = extractNestedPipelineErrorMessage(body, status);
  const code =
    typeof errorRecord?.code === 'string' && errorRecord.code.trim()
      ? errorRecord.code.trim()
      : (typeof status === 'number' ? `HTTP_${status}` : 'SERVERTOOL_FOLLOWUP_FAILED');
  const upstreamCode =
    typeof errorRecord?.upstreamCode === 'string' && errorRecord.upstreamCode.trim()
      ? errorRecord.upstreamCode.trim()
      : code;
  const requestId =
    typeof errorRecord?.request_id === 'string' && errorRecord.request_id.trim()
      ? errorRecord.request_id.trim()
      : undefined;

  const error = Object.assign(new Error(message), {
    code,
    upstreamCode,
    status,
    statusCode: status,
    requestExecutorProviderErrorStage: 'provider.followup',
    details: {
      ...(typeof status === 'number' ? { status } : {}),
      ...(requestId ? { requestId } : {}),
      reason: message,
      upstreamCode,
      requestExecutorProviderErrorStage: 'provider.followup'
    },
    response: body ? { data: body } : undefined
  });
  throw error;
}

async function buildServerToolNestedInput(args: {
  entryEndpoint: string;
  fallbackEntryEndpoint: string;
  requestId: string;
  body?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  baseMetadata?: Record<string, unknown>;
  requestSemantics?: Record<string, unknown>;
  mode: 'reenter' | 'client_inject';
  onMergeRuntimeMetaError?: BuildNestedMetadataLogger;
}): Promise<{
  nestedEntry: string;
  nestedMetadata: Record<string, unknown>;
  nestedInput: PipelineExecutionInput;
}> {
  const nestedEntry = args.entryEndpoint || args.fallbackEntryEndpoint;
  const nestedExtra = asRecord(args.metadata) ?? {};
  const materializedFollowup = materializeFollowupRequestSemantics({
    requestSemantics: args.requestSemantics,
    metadata: nestedExtra,
    baseMetadata: args.baseMetadata
  });
  const isFollowup =
    materializedFollowup.runtimeControl.serverToolFollowup
    || Boolean(materializedFollowup.runtimeControl.followupSource);
  const materializedRequestSemantics = stripResponsesOnlyRequestSemantics(
    materializedFollowup.requestSemantics,
    isFollowup
  );
  const nestedMetadata = buildServerToolNestedRequestMetadata({
    baseMetadata: args.baseMetadata,
    extraMetadata: nestedExtra,
    entryEndpoint: nestedEntry,
    requestSemantics: undefined,
    onMergeRuntimeMetaError: args.onMergeRuntimeMetaError
      ? (error) => {
          args.onMergeRuntimeMetaError?.(error, {
            requestId: args.requestId,
            entryEndpoint: nestedEntry,
            mode: args.mode
          });
        }
      : undefined
  });
  preserveLiveClientAbortCarriers({ source: args.baseMetadata, target: nestedMetadata });
  preserveLiveClientAbortCarriers({ source: nestedExtra, target: nestedMetadata });
  writeFollowupRuntimeControlToMetadata(nestedMetadata, materializedFollowup.runtimeControl);
  delete nestedMetadata.requestSemantics;
  delete nestedMetadata.stopMessageFollowupPolicy;
  const nestedRtForPolicy = nestedMetadata.__rt && typeof nestedMetadata.__rt === 'object' && !Array.isArray(nestedMetadata.__rt)
    ? (nestedMetadata.__rt as Record<string, unknown>)
    : undefined;
  if (nestedRtForPolicy) {
    delete nestedRtForPolicy.stopMessageFollowupPolicy;
  }
  const nestedRuntime =
    nestedMetadata.__rt && typeof nestedMetadata.__rt === 'object' && !Array.isArray(nestedMetadata.__rt)
      ? (nestedMetadata.__rt as Record<string, unknown>)
      : {};
  const followupSource = [nestedMetadata.clientInjectSource, nestedRuntime.clientInjectSource]
    .find((value) => typeof value === 'string' && value.trim().length > 0);
  const hasExplicitFollowupSource = typeof followupSource === 'string';
  const hasExplicitFollowupFlow =
    nestedRuntime.serverToolLoopState
    && typeof nestedRuntime.serverToolLoopState === 'object'
    && !Array.isArray(nestedRuntime.serverToolLoopState);
  const nestedRuntimeControl = readRuntimeControlProjection(nestedMetadata);
  const runtimeStopMessageDisabled = nestedRuntimeControl.stopMessageEnabled === false;
  const keepStopMessageEnabled =
    !hasExplicitFollowupSource
    && !hasExplicitFollowupFlow
    && !runtimeStopMessageDisabled
    && nestedRuntimeControl.stopMessageEnabled === true;
  if (!keepStopMessageEnabled) {
    writeStopMessageEnabledRuntimeControl(
      nestedMetadata,
      false,
      'servertool nested followup stop-message disabled'
    );
  }
  if (args.mode === 'reenter' && isFollowup) {
    delete nestedMetadata.clientInjectOnly;
    delete nestedMetadata.clientInjectText;
    delete nestedMetadata.clientTmuxSessionId;
    delete nestedMetadata.tmuxSessionId;
    delete nestedMetadata.clientTmuxTarget;
    delete nestedMetadata.tmuxTarget;
    delete nestedMetadata.inboundStream;
    delete nestedMetadata.clientAcceptsSse;
    delete nestedMetadata.stream;
  }

  const metadataRequestSemantics =
    nestedMetadata.requestSemantics && typeof nestedMetadata.requestSemantics === 'object' && !Array.isArray(nestedMetadata.requestSemantics)
      ? ({ ...(nestedMetadata.requestSemantics as Record<string, unknown>) } as Record<string, unknown>)
      : undefined;
  if (metadataRequestSemantics) {
    const responses =
      metadataRequestSemantics.responses && typeof metadataRequestSemantics.responses === 'object' && !Array.isArray(metadataRequestSemantics.responses)
        ? ({ ...(metadataRequestSemantics.responses as Record<string, unknown>) } as Record<string, unknown>)
        : undefined;
    const requestParameters =
      responses?.requestParameters && typeof responses.requestParameters === 'object' && !Array.isArray(responses.requestParameters)
        ? ({ ...(responses.requestParameters as Record<string, unknown>) } as Record<string, unknown>)
        : undefined;
    if (requestParameters) {
      delete requestParameters.model;
      delete requestParameters.stream;
      delete requestParameters.max_tokens;
      delete requestParameters.max_output_tokens;
      delete requestParameters.parallel_tool_calls;
      delete requestParameters.reasoning;
      responses!.requestParameters = requestParameters;
      metadataRequestSemantics.responses = responses!;
      nestedMetadata.requestSemantics = metadataRequestSemantics;
    }
  }

  const portModeCandidate =
    typeof (args.baseMetadata as Record<string, unknown> | undefined)?.routecodexPortMode === 'string'
      ? String((args.baseMetadata as Record<string, unknown>).routecodexPortMode).trim().toLowerCase()
      : '';
  const routeNameCandidate =
    typeof (args.baseMetadata as Record<string, unknown> | undefined)?.routeName === 'string'
      ? String((args.baseMetadata as Record<string, unknown>).routeName).trim()
      : typeof (args.baseMetadata as Record<string, unknown> | undefined)?.routeHint === 'string'
        ? String((args.baseMetadata as Record<string, unknown>).routeHint).trim()
        : typeof nestedMetadata.routeHint === 'string'
          ? String(nestedMetadata.routeHint).trim()
      : '';
  if (portModeCandidate === 'router' && routeNameCandidate && typeof nestedMetadata.routeHint !== 'string') {
    nestedMetadata.routeHint = routeNameCandidate;
  }
  if (portModeCandidate) {
    const rt =
      nestedMetadata.__rt && typeof nestedMetadata.__rt === 'object' && !Array.isArray(nestedMetadata.__rt)
        ? (nestedMetadata.__rt as Record<string, unknown>)
        : {};
    nestedMetadata.__rt = {
      ...rt,
      serverToolFollowupMode: portModeCandidate
    };
  }

  const body = await cloneNestedBodyWithSemantics(
    nestedEntry,
    args.body,
    materializedRequestSemantics,
    isFollowup
  );
  const headers = stripSseRequestHeadersForNonStreamingFollowup(
    cloneStringHeaders(nestedMetadata.clientHeaders),
    body
  ) ?? {};
  return {
    nestedEntry,
    nestedMetadata,
    nestedInput: {
      entryEndpoint: nestedEntry,
      method: 'POST',
      requestId: args.requestId,
      headers,
      query: {},
      body,
      metadata: nestedMetadata
    }
  };
}

export async function executeServerToolReenterPipeline(args: {
  entryEndpoint: string;
  fallbackEntryEndpoint: string;
  requestId: string;
  body?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  baseMetadata?: Record<string, unknown>;
  requestSemantics?: Record<string, unknown>;
  executeNested: ServerToolNestedExecute;
  onMergeRuntimeMetaError?: BuildNestedMetadataLogger;
  runClientInjectBeforeNested?: boolean;
}): Promise<{
  body?: Record<string, unknown>;
  sseStream?: unknown;
  format?: string;
}> {
  const {
    nestedMetadata,
    nestedInput
  } = await buildServerToolNestedInput({
    entryEndpoint: args.entryEndpoint,
    fallbackEntryEndpoint: args.fallbackEntryEndpoint,
    requestId: args.requestId,
    body: args.body,
    metadata: args.metadata,
    baseMetadata: args.baseMetadata,
    requestSemantics: args.requestSemantics,
    mode: 'reenter',
    onMergeRuntimeMetaError: args.onMergeRuntimeMetaError
  });

  if (args.runClientInjectBeforeNested !== false) {
    throwIfNestedFollowupAborted(nestedMetadata);
    const injectResult = await runClientInjectionFlowBeforeReenter({
      nestedMetadata,
      requestBody: asObjectBody(args.body),
      requestId: args.requestId
    });
    if (injectResult.clientInjectOnlyHandled) {
      return {};
    }
  }
  const forcedProviderKey = readForcedProviderKey(nestedMetadata);
  const maxAttempts = forcedProviderKey ? SAME_PROVIDER_FOLLOWUP_MAX_ATTEMPTS : 1;
  let lastError: unknown;
  let nestedResult: PipelineExecutionResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Important: each retry must start from an immutable snapshot of nested input.
    // Downstream pipeline stages may mutate `input.body` in-place (append tool traces, etc.).
    // Reusing the same object would accumulate history drift across retries.
    const nestedInputAttempt = clonePipelineInputForRetry(nestedInput);
    try {
      throwIfNestedFollowupAborted(nestedInputAttempt.metadata);
      await captureNestedResponsesRequestContext(nestedInputAttempt);
      throwIfNestedFollowupAborted(nestedInputAttempt.metadata);
      const attemptResult = await awaitNestedExecutionWithFailFast({
        promise: args.executeNested(nestedInputAttempt),
        abortSignal: getNestedFollowupAbortSignal(
          nestedInputAttempt.metadata as Record<string, unknown> | undefined
        ),
        abortCarrier: nestedInputAttempt.metadata
      });
      throwIfNestedFollowupAborted(nestedInputAttempt.metadata);
      throwIfNestedPipelineReturnedError(attemptResult);
      nestedResult = attemptResult;
      break;
    } catch (error) {
      lastError = error;
      if (isClientDisconnectAbortError(error)) {
        break;
      }
      if (isTerminalFollowupDispatchError(error)) {
        break;
      }
      const isLastAttempt = attempt >= maxAttempts;
      if (isLastAttempt) {
        break;
      }
      const backoffScopeKey = `request:${args.requestId}|provider:${forcedProviderKey}`;
      const backoffMs = recordErrorActionBackoff({
        category: 'servertool_followup',
        scopeKey: backoffScopeKey
      });
      console.warn(
        `[servertool.followup] req=${args.requestId} forcedProvider=${forcedProviderKey} `
        + `attempt=${attempt}/${maxAttempts} failed, retry in ${backoffMs}ms: `
        + `${error instanceof Error ? error.message : String(error)}`
      );
      await awaitNestedExecutionWithFailFast({
        promise: waitErrorActionBackoffWithGate({
          category: 'servertool_followup',
          scopeKey: backoffScopeKey,
          ms: backoffMs
        }),
        abortSignal: getNestedFollowupAbortSignal(nestedInput.metadata),
        abortCarrier: nestedInput.metadata
      });
    }
  }

  if (!nestedResult) {
    throw lastError instanceof Error
      ? lastError
      : new Error(
        `[servertool] followup failed after ${maxAttempts} attempts`
      );
  }
  const nestedBody =
    nestedResult.body && typeof nestedResult.body === 'object'
      ? (nestedResult.body as Record<string, unknown>)
      : undefined;
  await rebindNestedResponsesContextToResponseId(nestedInput, nestedBody);
  return { body: nestedBody };
}

export async function executeServerToolClientInjectDispatch(args: {
  entryEndpoint: string;
  fallbackEntryEndpoint: string;
  requestId: string;
  body?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  baseMetadata?: Record<string, unknown>;
  requestSemantics?: Record<string, unknown>;
  onMergeRuntimeMetaError?: BuildNestedMetadataLogger;
}): Promise<{ ok: boolean; reason?: string }> {
  const { nestedMetadata } = await buildServerToolNestedInput({
    entryEndpoint: args.entryEndpoint,
    fallbackEntryEndpoint: args.fallbackEntryEndpoint,
    requestId: args.requestId,
    body: args.body,
    metadata: args.metadata,
    baseMetadata: args.baseMetadata,
    requestSemantics: args.requestSemantics,
    mode: 'client_inject',
    onMergeRuntimeMetaError: args.onMergeRuntimeMetaError
  });

  const injectResult = await runClientInjectionFlowBeforeReenter({
    nestedMetadata,
    requestBody: asObjectBody(args.body),
    requestId: args.requestId
  });

  if (injectResult.clientInjectOnlyHandled) {
    return { ok: true };
  }

  return { ok: false, reason: 'client_inject_not_handled' };
}
