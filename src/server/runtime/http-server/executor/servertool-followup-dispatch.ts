import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../handlers/types.js';
import { asRecord } from '../provider-utils.js';
import { runClientInjectionFlowBeforeReenter } from './client-injection-flow.js';
import { buildServerToolNestedRequestMetadata } from './servertool-followup-metadata.js';
import {
  awaitNestedExecutionWithFailFast,
  getNestedFollowupAbortSignal,
  resolveServerToolNestedFollowupTimeoutMs
} from './servertool-followup-fail-fast.js';
import { isGoalCapableRequestSemantics } from './goal-capable-request.js';

type ServerToolNestedExecute = (input: PipelineExecutionInput) => Promise<PipelineExecutionResult>;

type BuildNestedMetadataLogger = (error: unknown, details: {
  requestId: string;
  entryEndpoint: string;
  mode: 'reenter' | 'client_inject';
}) => void;


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

function asObjectBody(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cloneJsonRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readToolName(tool: unknown): string {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    return '';
  }
  const directName =
    typeof (tool as { name?: unknown }).name === 'string'
      ? String((tool as { name: string }).name).trim().toLowerCase()
      : '';
  if (directName) {
    return directName;
  }
  const fn = (tool as { function?: unknown }).function;
  if (!fn || typeof fn !== 'object' || Array.isArray(fn)) {
    return '';
  }
  return typeof (fn as { name?: unknown }).name === 'string'
    ? String((fn as { name: string }).name).trim().toLowerCase()
    : '';
}

function isCollapsedReasoningStopOnlyTools(tools: unknown): boolean {
  if (!Array.isArray(tools) || tools.length === 0) {
    return false;
  }
  const names = tools.map(readToolName).filter(Boolean);
  return names.length > 0 && names.every((name) => name === 'reasoning.stop' || name === 'reasoning_stop' || name === 'reasoning-stop');
}

function mergeUniqueTools(primary?: unknown[], secondary?: unknown[]): unknown[] | undefined {
  const out: unknown[] = [];
  const seen = new Set<string>();
  const append = (tool: unknown) => {
    const name = readToolName(tool);
    if (!name || seen.has(name)) {
      return;
    }
    seen.add(name);
    out.push(tool);
  };
  for (const tool of primary ?? []) {
    append(tool);
  }
  for (const tool of secondary ?? []) {
    append(tool);
  }
  return out.length ? out : undefined;
}

function extractClientToolsRaw(requestSemantics: Record<string, unknown> | undefined): unknown[] | undefined {
  if (!requestSemantics || typeof requestSemantics !== 'object') {
    return undefined;
  }
  const toolsNode =
    requestSemantics.tools && typeof requestSemantics.tools === 'object' && !Array.isArray(requestSemantics.tools)
      ? (requestSemantics.tools as Record<string, unknown>)
      : undefined;
  return Array.isArray(toolsNode?.clientToolsRaw) ? toolsNode.clientToolsRaw : undefined;
}

function isServerToolFollowup(requestSemantics: Record<string, unknown> | undefined): boolean {
  const routecodex =
    requestSemantics?.__routecodex && typeof requestSemantics.__routecodex === 'object' && !Array.isArray(requestSemantics.__routecodex)
      ? (requestSemantics.__routecodex as Record<string, unknown>)
      : undefined;
  return routecodex?.serverToolFollowup === true;
}

function readManagedStoplessGoalStatusFromSemantics(
  requestSemantics: Record<string, unknown> | undefined
): string | undefined {
  const routecodex =
    requestSemantics?.__routecodex && typeof requestSemantics.__routecodex === 'object' && !Array.isArray(requestSemantics.__routecodex)
      ? (requestSemantics.__routecodex as Record<string, unknown>)
      : undefined;
  const statusCandidate =
    typeof routecodex?.stoplessGoalStatus === 'string'
      ? routecodex.stoplessGoalStatus
      : requestSemantics?.stoplessGoalState && typeof requestSemantics.stoplessGoalState === 'object' && !Array.isArray(requestSemantics.stoplessGoalState)
        ? (requestSemantics.stoplessGoalState as Record<string, unknown>).status
        : undefined;
  const normalized = typeof statusCandidate === 'string' ? statusCandidate.trim().toLowerCase() : '';
  return normalized || undefined;
}

function isManagedStoplessGoalRequestSemantics(requestSemantics: Record<string, unknown> | undefined): boolean {
  const status = readManagedStoplessGoalStatusFromSemantics(requestSemantics);
  return status === 'active' || status === 'paused' || status === 'stopped' || status === 'completed';
}

function readBooleanFlag(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

function readFollowupMarkerFromMetadata(
  metadata?: Record<string, unknown>
): { serverToolFollowup: boolean; followupSource?: string; stoplessGoalStatus?: string } {
  const rt =
    metadata?.__rt && typeof metadata.__rt === 'object' && !Array.isArray(metadata.__rt)
      ? (metadata.__rt as Record<string, unknown>)
      : undefined;
  const sourceCandidate = [
    metadata?.clientInjectSource,
    rt?.clientInjectSource
  ].find((value) => typeof value === 'string' && value.trim().length > 0);

  return {
    serverToolFollowup: [
      metadata?.serverToolFollowup,
      metadata?.isServerToolFollowup,
      rt?.serverToolFollowup
    ].some(readBooleanFlag),
    ...(typeof rt?.stoplessGoalStatus === 'string' && rt.stoplessGoalStatus.trim()
      ? { stoplessGoalStatus: rt.stoplessGoalStatus.trim().toLowerCase() }
      : {}),
    ...(typeof sourceCandidate === 'string' && sourceCandidate.trim()
      ? { followupSource: sourceCandidate.trim() }
      : {})
  };
}

function materializeFollowupRequestSemantics(args: {
  requestSemantics?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  baseMetadata?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const fromMetadata = readFollowupMarkerFromMetadata(args.metadata);
  const fromBaseMetadata = readFollowupMarkerFromMetadata(args.baseMetadata);
  const serverToolFollowup =
    isServerToolFollowup(args.requestSemantics)
    || fromMetadata.serverToolFollowup
    || fromBaseMetadata.serverToolFollowup;
  const followupSource = fromMetadata.followupSource ?? fromBaseMetadata.followupSource;
  const stoplessGoalStatus = fromMetadata.stoplessGoalStatus ?? fromBaseMetadata.stoplessGoalStatus;

  if (!args.requestSemantics && !serverToolFollowup && !followupSource && !stoplessGoalStatus) {
    return undefined;
  }

  const nextSemantics = cloneJsonRecord((args.requestSemantics ?? {}) as Record<string, unknown>);
  if (!serverToolFollowup && !followupSource && !stoplessGoalStatus) {
    return nextSemantics;
  }

  const routecodex =
    nextSemantics.__routecodex && typeof nextSemantics.__routecodex === 'object' && !Array.isArray(nextSemantics.__routecodex)
      ? (nextSemantics.__routecodex as Record<string, unknown>)
      : {};
  nextSemantics.__routecodex = {
    ...routecodex,
    ...(serverToolFollowup ? { serverToolFollowup: true } : {}),
    ...(followupSource ? { serverToolFollowupSource: followupSource } : {}),
    ...(stoplessGoalStatus ? { stoplessGoalStatus } : {})
  };
  return nextSemantics;
}

function sanitizeFollowupRequestSemantics(
  requestSemantics: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!isServerToolFollowup(requestSemantics)) {
    return requestSemantics;
  }
  const responsesNode = asRecord(requestSemantics?.responses);
  const requestParameters = asRecord(responsesNode?.requestParameters);
  if (!responsesNode || !requestParameters) {
    return requestSemantics;
  }

  const nextRequestParameters = { ...requestParameters };
  delete nextRequestParameters.model;
  delete nextRequestParameters.max_tokens;
  delete nextRequestParameters.max_output_tokens;
  if (Object.keys(nextRequestParameters).length === Object.keys(requestParameters).length) {
    return requestSemantics;
  }

  const nextSemantics = cloneJsonRecord(requestSemantics) as Record<string, unknown>;
  const nextResponsesNode = asRecord(nextSemantics.responses);
  if (!nextResponsesNode) {
    return requestSemantics;
  }
  if (Object.keys(nextRequestParameters).length === 0) {
    delete nextResponsesNode.requestParameters;
  } else {
    nextResponsesNode.requestParameters = nextRequestParameters;
  }
  return nextSemantics;
}

function restoreFollowupRootToolsIfNeeded(
  body: Record<string, unknown>,
  requestSemantics: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!isServerToolFollowup(requestSemantics)) {
    return body;
  }
  const clientToolsRaw = extractClientToolsRaw(requestSemantics);
  if (!Array.isArray(clientToolsRaw) || clientToolsRaw.length === 0) {
    return body;
  }
  const rootTools = Array.isArray(body.tools) ? body.tools : undefined;
  if (isGoalCapableRequestSemantics(requestSemantics) || isManagedStoplessGoalRequestSemantics(requestSemantics)) {
    return {
      ...body,
      tools: clientToolsRaw
    };
  }
  if (rootTools && !isCollapsedReasoningStopOnlyTools(rootTools)) {
    return body;
  }
  const mergedTools = mergeUniqueTools(clientToolsRaw, rootTools);
  if (!mergedTools?.length) {
    return body;
  }
  return {
    ...body,
    tools: mergedTools
  };
}

function sanitizeFollowupRootBodyRequestParameters(
  body: Record<string, unknown>,
  requestSemantics: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!isServerToolFollowup(requestSemantics)) {
    return body;
  }
  let changed = false;
  const nextBody = { ...body };
  if ('max_tokens' in nextBody) {
    delete nextBody.max_tokens;
    changed = true;
  }
  if ('max_output_tokens' in nextBody) {
    delete nextBody.max_output_tokens;
    changed = true;
  }
  return changed ? nextBody : body;
}

function cloneNestedBodyWithSemantics(
  body: Record<string, unknown> | undefined,
  requestSemantics: Record<string, unknown> | undefined
): Record<string, unknown> {
  const out = sanitizeFollowupRootBodyRequestParameters(
    restoreFollowupRootToolsIfNeeded(body ? { ...body } : {}, requestSemantics),
    requestSemantics
  );
  if (
    requestSemantics
    && typeof requestSemantics === 'object'
    && !Array.isArray(requestSemantics)
    && (!out.semantics || typeof out.semantics !== 'object' || Array.isArray(out.semantics))
  ) {
    out.semantics = requestSemantics;
  }
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

function buildServerToolNestedInput(args: {
  entryEndpoint: string;
  fallbackEntryEndpoint: string;
  requestId: string;
  body?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  baseMetadata?: Record<string, unknown>;
  requestSemantics?: Record<string, unknown>;
  mode: 'reenter' | 'client_inject';
  onMergeRuntimeMetaError?: BuildNestedMetadataLogger;
}): {
  nestedEntry: string;
  nestedMetadata: Record<string, unknown>;
  nestedInput: PipelineExecutionInput;
} {
  const nestedEntry = args.entryEndpoint || args.fallbackEntryEndpoint;
  const nestedExtra = asRecord(args.metadata) ?? {};
  const materializedRequestSemantics = materializeFollowupRequestSemantics({
    requestSemantics: args.requestSemantics,
    metadata: nestedExtra,
    baseMetadata: args.baseMetadata
  });
  const sanitizedRequestSemantics = sanitizeFollowupRequestSemantics(materializedRequestSemantics);
  const nestedMetadata = buildServerToolNestedRequestMetadata({
    baseMetadata: args.baseMetadata,
    extraMetadata: nestedExtra,
    entryEndpoint: nestedEntry,
    requestSemantics: sanitizedRequestSemantics,
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

  return {
    nestedEntry,
    nestedMetadata,
    nestedInput: {
      entryEndpoint: nestedEntry,
      method: 'POST',
      requestId: args.requestId,
      headers: cloneStringHeaders(nestedMetadata.clientHeaders) ?? {},
      query: {},
      body: cloneNestedBodyWithSemantics(args.body, sanitizedRequestSemantics),
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
  __sse_responses?: unknown;
  format?: string;
}> {
  const {
    nestedMetadata,
    nestedInput
  } = buildServerToolNestedInput({
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
    const injectResult = await runClientInjectionFlowBeforeReenter({
      nestedMetadata,
      requestBody: asObjectBody(args.body),
      requestId: args.requestId
    });
    if (injectResult.clientInjectOnlyHandled) {
      return {};
    }
  }

  const nestedResult = await awaitNestedExecutionWithFailFast({
    promise: args.executeNested(nestedInput),
    abortSignal: getNestedFollowupAbortSignal(nestedMetadata),
    timeoutMs: resolveServerToolNestedFollowupTimeoutMs(),
    requestId: args.requestId
  });
  throwIfNestedPipelineReturnedError(nestedResult);
  const nestedBody =
    nestedResult.body && typeof nestedResult.body === 'object'
      ? (nestedResult.body as Record<string, unknown>)
      : undefined;
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
  const { nestedMetadata } = buildServerToolNestedInput({
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
