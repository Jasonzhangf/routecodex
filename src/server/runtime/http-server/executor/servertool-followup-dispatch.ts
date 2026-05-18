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

const SAME_PROVIDER_FOLLOWUP_MAX_ATTEMPTS = 3;
const SAME_PROVIDER_FOLLOWUP_BACKOFF_BASE_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function readForcedProviderKey(metadata?: Record<string, unknown>): string | undefined {
  const raw = metadata?.__shadowCompareForcedProviderKey;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

function computeExponentialBackoffMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  return SAME_PROVIDER_FOLLOWUP_BACKOFF_BASE_MS * (2 ** (safeAttempt - 1));
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

function readServerToolFollowupSource(requestSemantics: Record<string, unknown> | undefined): string {
  const routecodex =
    requestSemantics?.__routecodex && typeof requestSemantics.__routecodex === 'object' && !Array.isArray(requestSemantics.__routecodex)
      ? (requestSemantics.__routecodex as Record<string, unknown>)
      : undefined;
  const raw = routecodex?.serverToolFollowupSource;
  return typeof raw === 'string' && raw.trim().length ? raw.trim() : '';
}

function extractAnySemanticsToolList(requestSemantics: Record<string, unknown> | undefined): unknown[] | undefined {
  if (!requestSemantics || typeof requestSemantics !== 'object') {
    return undefined;
  }
  const toolsNode =
    requestSemantics.tools && typeof requestSemantics.tools === 'object' && !Array.isArray(requestSemantics.tools)
      ? (requestSemantics.tools as Record<string, unknown>)
      : undefined;
  const candidates = [
    toolsNode?.clientToolsRaw,
    toolsNode?.baselineTools,
    toolsNode?.canonicalTools,
    requestSemantics.tools
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
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
    || fromBaseMetadata.serverToolFollowup
    || Boolean(fromMetadata.followupSource)
    || Boolean(fromBaseMetadata.followupSource);
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


function restoreFollowupRootToolsIfNeeded(
  body: Record<string, unknown>,
  requestSemantics: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!isServerToolFollowup(requestSemantics)) {
    return body;
  }
  const clientToolsRaw = extractClientToolsRaw(requestSemantics);
  const followupSource = readServerToolFollowupSource(requestSemantics);
  const semanticsTools = extractAnySemanticsToolList(requestSemantics);
  const rootTools = Array.isArray(body.tools) ? body.tools : undefined;
  const fullTools = mergeUniqueTools(clientToolsRaw, semanticsTools);

  if (followupSource === 'servertool.stopless_goal_continue' && !isGoalCapableRequestSemantics(requestSemantics)) {
    // Non-/goal stopless followup must run with a complete tool set.
    // Make it happen by force-restoring from semantics tool truth (clientToolsRaw/baseline/canonical),
    // and merge existing root tools if present.
    const merged = mergeUniqueTools(fullTools, rootTools);
    if (merged?.length) {
      return {
        ...body,
        tools: merged
      };
    }
  }

  if (!fullTools?.length) {
    return body;
  }
  if (isGoalCapableRequestSemantics(requestSemantics) || isManagedStoplessGoalRequestSemantics(requestSemantics)) {
    return {
      ...body,
      tools: fullTools
    };
  }
  if (rootTools && rootTools.length > 0) {
    return body;
  }
  const mergedTools = mergeUniqueTools(fullTools, rootTools);
  if (!mergedTools?.length) {
    return body;
  }
  return {
    ...body,
    tools: mergedTools
  };
}

function cloneNestedBodyWithSemantics(
  body: Record<string, unknown> | undefined,
  requestSemantics: Record<string, unknown> | undefined
): Record<string, unknown> {
  const out = restoreFollowupRootToolsIfNeeded(body ? { ...body } : {}, requestSemantics);
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
  const nestedMetadata = buildServerToolNestedRequestMetadata({
    baseMetadata: args.baseMetadata,
    extraMetadata: nestedExtra,
    entryEndpoint: nestedEntry,
    requestSemantics: materializedRequestSemantics,
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

  const baseProviderKeyCandidate =
    typeof (args.baseMetadata as Record<string, unknown> | undefined)?.providerKey === 'string'
      ? String((args.baseMetadata as Record<string, unknown>).providerKey).trim()
      : '';
  const extraProviderKeyCandidate =
    typeof nestedExtra.providerKey === 'string' ? String(nestedExtra.providerKey).trim() : '';
  const pinnedProviderKey = baseProviderKeyCandidate || extraProviderKeyCandidate;
  if (pinnedProviderKey && !readForcedProviderKey(nestedMetadata)) {
    nestedMetadata.__shadowCompareForcedProviderKey = pinnedProviderKey;
  }

  const portModeCandidate =
    typeof (args.baseMetadata as Record<string, unknown> | undefined)?.routecodexPortMode === 'string'
      ? String((args.baseMetadata as Record<string, unknown>).routecodexPortMode).trim().toLowerCase()
      : '';
  const routeNameCandidate =
    typeof (args.baseMetadata as Record<string, unknown> | undefined)?.routeName === 'string'
      ? String((args.baseMetadata as Record<string, unknown>).routeName).trim()
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

  return {
    nestedEntry,
    nestedMetadata,
    nestedInput: {
      entryEndpoint: nestedEntry,
      method: 'POST',
      requestId: args.requestId,
      headers: cloneStringHeaders(nestedMetadata.clientHeaders) ?? {},
      query: {},
      body: cloneNestedBodyWithSemantics(args.body, materializedRequestSemantics),
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
  const forcedProviderKey = readForcedProviderKey(nestedMetadata);
  const maxAttempts = forcedProviderKey ? SAME_PROVIDER_FOLLOWUP_MAX_ATTEMPTS : 1;
  let lastError: unknown;
  let nestedResult: PipelineExecutionResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      nestedResult = await awaitNestedExecutionWithFailFast({
        promise: args.executeNested(nestedInput),
        abortSignal: getNestedFollowupAbortSignal(nestedMetadata),
        timeoutMs: resolveServerToolNestedFollowupTimeoutMs(),
        requestId: args.requestId
      });
      throwIfNestedPipelineReturnedError(nestedResult);
      break;
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt >= maxAttempts;
      if (isLastAttempt) {
        break;
      }
      const backoffMs = computeExponentialBackoffMs(attempt);
      console.warn(
        `[servertool.followup] req=${args.requestId} forcedProvider=${forcedProviderKey} `
        + `attempt=${attempt}/${maxAttempts} failed, retry in ${backoffMs}ms: `
        + `${error instanceof Error ? error.message : String(error)}`
      );
      await sleep(backoffMs);
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
