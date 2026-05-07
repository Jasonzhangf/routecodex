import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../handlers/types.js';
import { asRecord } from '../provider-utils.js';
import { runClientInjectionFlowBeforeReenter } from './client-injection-flow.js';
import { buildServerToolNestedRequestMetadata } from './servertool-followup-metadata.js';

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

function cloneNestedBodyWithSemantics(
  body: Record<string, unknown> | undefined,
  requestSemantics: Record<string, unknown> | undefined
): Record<string, unknown> {
  const out = body ? { ...body } : {};
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
  const nestedMetadata = buildServerToolNestedRequestMetadata({
    baseMetadata: args.baseMetadata,
    extraMetadata: nestedExtra,
    entryEndpoint: nestedEntry,
    requestSemantics: args.requestSemantics,
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
      body: cloneNestedBodyWithSemantics(args.body, args.requestSemantics),
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
      return { body: { ok: true, mode: 'client_inject_only' } };
    }
  }

  const nestedResult = await args.executeNested(nestedInput);
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
