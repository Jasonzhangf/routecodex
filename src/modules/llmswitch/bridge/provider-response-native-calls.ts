import { getProviderResponseNativeBindingSync } from './provider-response-native-host.js';
import {
  assertNativeObject,
  callNativeJsonCapability,
  parseNativeBooleanResult,
  parseNativeJsonResult,
  parseNativeOptionalObjectResult,
  requireNativeFunction,
  stringifyNativeJsonArg,
} from './native-json-invoker.js';

type JsonObject = Record<string, unknown>;

export type ProviderResponseRuntimeEffectPlan = {
  servertoolRuntimeActions?: unknown[];
  stoplessMetadataCenterWrite?: unknown;
  runtimeStateWrite?: unknown;
  streamPipe?: unknown;
  [key: string]: unknown;
};

export type PublishResponsesRecordPlan = {
  recordArgs: {
    requestId: string;
    response: Record<string, unknown>;
    sessionId?: string;
    conversationId?: string;
    providerKey?: string;
    matchedPort?: number;
    routingPolicyGroup?: string;
    routeHint?: string;
  } | null;
  finalizeArgs: {
    requestId: string;
    keepForSubmitToolOutputs: boolean;
  } | null;
  usageArgs: {
    usage?: unknown;
  } | null;
};

export type ProviderResponseNativePlan = {
  success: boolean;
  requestId: string;
  payload?: unknown;
  error?: { code?: string; message?: string };
  effectPlan: { effects: unknown[] };
  diagnostics: Array<Record<string, unknown>>;
};

export type ProviderResponseToolValidationResult = {
  ok: boolean;
  reason?: string;
  message?: string;
  missingFields?: string[];
  normalizedArgs?: string;
};

export type NativeSseRuntimeProtocol = string;

export type NativeSseFramesOutput = {
  frames: string[];
  stats?: Record<string, unknown>;
};

const label = 'provider-response-native-calls';

function parseProviderResponseNativeRecord(raw: unknown): Record<string, unknown> | undefined {
  return parseNativeOptionalObjectResult('router-hotpath native export', raw, { label });
}

function parseProviderResponseNativeBooleanResult(raw: unknown): boolean {
  return parseNativeBooleanResult('router-hotpath native export', raw, { label });
}

function callProviderResponseToolValidationNative<T>(
  functionName: string,
  input: Record<string, unknown>
): T {
  try {
    return callNativeJsonCapability<T>(
      getProviderResponseNativeBindingSync,
      functionName,
      [input],
      { label }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`provider_response_tool_validation_native_failed: ${functionName}: ${message}`);
  }
}

export function asFlatRecord(value: unknown): Record<string, unknown> | undefined {
  const raw = requireNativeFunction(
    getProviderResponseNativeBindingSync,
    'asFlatRecordJson',
    { label }
  )(stringifyNativeJsonArg('asFlatRecordJson', value, { label }));
  return parseProviderResponseNativeRecord(raw);
}

export function extractFirstBalancedJsonObject(raw: string): string | undefined {
  const raw2 = requireNativeFunction(
    getProviderResponseNativeBindingSync,
    'extractFirstBalancedJsonObjectJson',
    { label }
  )(raw);
  return raw2 !== null && raw2 !== undefined ? String(raw2) : undefined;
}

export function tryParseJsonLikeString(raw: string): unknown {
  const raw2 = requireNativeFunction(
    getProviderResponseNativeBindingSync,
    'tryParseJsonLikeStringJson',
    { label }
  )(raw);
  return raw2 !== null && raw2 !== undefined ? JSON.parse(String(raw2)) : undefined;
}

export function extractContentTextForStoplessScan(content: unknown): string {
  return String(requireNativeFunction(
    getProviderResponseNativeBindingSync,
    'extractContentTextForStoplessScanJson',
    { label }
  )(stringifyNativeJsonArg('extractContentTextForStoplessScanJson', content, { label })));
}

export function extractLatestUserTextForStoplessScan(source: unknown): string {
  return String(requireNativeFunction(
    getProviderResponseNativeBindingSync,
    'extractLatestUserTextForStoplessScanJson',
    { label }
  )(stringifyNativeJsonArg('extractLatestUserTextForStoplessScanJson', source, { label })));
}

export function hasStoplessDirectiveInRequestPayload(source: unknown): boolean {
  return requireNativeFunction(
    getProviderResponseNativeBindingSync,
    'hasStoplessDirectiveInRequestPayloadJson',
    { label }
  )(stringifyNativeJsonArg('hasStoplessDirectiveInRequestPayloadJson', source, { label })) === true;
}

export function findNestedRawString(payload: unknown, depth = 3): string {
  void depth;
  return String(requireNativeFunction(
    getProviderResponseNativeBindingSync,
    'findNestedRawStringJson',
    { label }
  )(stringifyNativeJsonArg('findNestedRawStringJson', payload, { label })));
}

export function findNestedErrorMarker(payload: unknown, depth = 3): string {
  void depth;
  return String(requireNativeFunction(
    getProviderResponseNativeBindingSync,
    'findNestedErrorMarkerJson',
    { label }
  )(stringifyNativeJsonArg('findNestedErrorMarkerJson', payload, { label })));
}

export function containsBroadKillCommand(cmd: string): boolean {
  const parsed = callProviderResponseToolValidationNative<{ result: boolean }>('containsBroadKillCommandJson', { cmd });
  return parsed.result === true;
}

export function hasInvalidShellWrapperShape(cmd: string): boolean {
  const parsed = callProviderResponseToolValidationNative<{ result: boolean }>('hasInvalidShellWrapperShapeJson', { cmd });
  return parsed.result === true;
}

export function validateCanonicalClientToolCall(
  name: string,
  argsString: string,
  _declaredToolNames?: Set<string>
): ProviderResponseToolValidationResult {
  return callProviderResponseToolValidationNative<ProviderResponseToolValidationResult>(
    'validateCanonicalClientToolCallJson',
    { name, argsString }
  );
}

export function isGenericBridgeResponseContractError(args: {
  error: Record<string, unknown>;
  message: string;
}): boolean {
  const raw = requireNativeFunction(
    getProviderResponseNativeBindingSync,
    'isGenericBridgeResponseContractErrorJson',
    { label }
  )(stringifyNativeJsonArg('isGenericBridgeResponseContractErrorJson', {
    errorCode: String(args.error.code ?? ''),
    errorName: String(args.error.name ?? ''),
    message: args.message,
  }, { label }));
  return parseProviderResponseNativeBooleanResult(raw);
}

export function isContextLengthExceededError(
  message: string,
  upstreamCode?: string,
  detailReason?: string
): boolean {
  const raw = requireNativeFunction(
    getProviderResponseNativeBindingSync,
    'isContextLengthExceededErrorJson',
    { label }
  )(stringifyNativeJsonArg('isContextLengthExceededErrorJson', {
    message,
    upstreamCode: upstreamCode ?? null,
    detailReason: detailReason ?? null,
  }, { label }));
  return parseProviderResponseNativeBooleanResult(raw);
}

export function isRetryableNetworkSseWrapperError(message: string, upstreamCode?: string, statusCode?: number): boolean {
  const raw = requireNativeFunction(
    getProviderResponseNativeBindingSync,
    'isRetryableNetworkSseWrapperErrorJson',
    { label }
  )(stringifyNativeJsonArg('isRetryableNetworkSseWrapperErrorJson', {
    message,
    upstreamCode: upstreamCode ?? null,
    statusCode: statusCode ?? null,
  }, { label }));
  return parseProviderResponseNativeBooleanResult(raw);
}

export function extractBridgeProviderResponsePayload(
  body: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  const raw = requireNativeFunction(
    getProviderResponseNativeBindingSync,
    'extractBridgeProviderResponsePayloadJson',
    { label }
  )(stringifyNativeJsonArg('extractBridgeProviderResponsePayloadJson', body ?? {}, { label }));
  return parseProviderResponseNativeRecord(raw);
}

export function executeHubPipelineWithNative(input: {
  config: Record<string, unknown>;
  request: Record<string, unknown>;
}): ProviderResponseNativePlan {
  return callNativeJsonCapability(
    getProviderResponseNativeBindingSync,
    'executeHubPipelineJson',
    [input],
    { label }
  );
}

export function buildProviderResponseMetadataSnapshotWithNative(input: unknown): {
  metadataCenterSnapshot?: Record<string, unknown> | null;
} {
  return callNativeJsonCapability(
    getProviderResponseNativeBindingSync,
    'buildProviderResponseMetadataSnapshotJson',
    [input],
    { label }
  );
}

export function normalizeProviderResponseEffectPlanWithNative(input: {
  effects: unknown[];
}): ProviderResponseRuntimeEffectPlan {
  return callNativeJsonCapability(
    getProviderResponseNativeBindingSync,
    'normalizeProviderResponseEffectPlanJson',
    [input],
    { label }
  );
}

export function resolveProviderProtocolWithNative(input: unknown): { providerProtocol: string } {
  return callNativeJsonCapability(
    getProviderResponseNativeBindingSync,
    'resolveProviderProtocolJson',
    [input],
    { label }
  );
}

export function publishResponsesRecordPlanWithNative(args: {
  requestId: string;
  response: unknown;
  context: unknown;
  runtimeStateWrite: unknown;
  entryEndpoint: string;
}): PublishResponsesRecordPlan {
  const fn = requireNativeFunction(
    getProviderResponseNativeBindingSync,
    'publishResponsesRecordPlanJson',
    { label }
  );
  const raw = fn(
    String(args.requestId ?? ''),
    stringifyNativeJsonArg('publishResponsesRecordPlanJson', args.response ?? null, { label }),
    stringifyNativeJsonArg('publishResponsesRecordPlanJson', args.context ?? null, { label }),
    stringifyNativeJsonArg('publishResponsesRecordPlanJson', args.runtimeStateWrite ?? null, { label }),
    String(args.entryEndpoint ?? '')
  );
  return parseNativeJsonResult<PublishResponsesRecordPlan>(
    'publishResponsesRecordPlanJson',
    raw,
    { label }
  );
}

export function ensureRuntimeMetadataWithNative(carrier: Record<string, unknown>): Record<string, unknown> {
  return callNativeJsonCapability<Record<string, unknown>>(
    getProviderResponseNativeBindingSync,
    'ensureRuntimeMetadataJson',
    [carrier],
    { label }
  );
}

export function projectMetadataWritePlanToRuntimeControlWritePlanWithNative(plan: unknown): {
  runtimeControl?: Record<string, unknown>;
} {
  const parsed = callNativeJsonCapability(
    getProviderResponseNativeBindingSync,
    'projectMetadataWritePlanToRuntimeControlWritePlanJson',
    [{ plan }],
    { label }
  );
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as { runtimeControl?: Record<string, unknown> }
    : {};
}

export function buildProviderSseStreamReadErrorDescriptorWithNative(input: {
  message: string;
  code?: string;
  upstreamCode?: string;
}): {
  message: string;
  code?: string;
  upstreamCode?: string;
  statusCode?: number;
  retryable?: boolean;
  requestExecutorProviderErrorStage?: string;
} {
  // feature_id: hub.response_provider_sse_materialization
  // canonical_builder: build_provider_sse_stream_read_error_descriptor
  return callNativeJsonCapability(
    getProviderResponseNativeBindingSync,
    'buildProviderSseStreamReadErrorDescriptorJson',
    [input],
    { label }
  );
}

export function materializeProviderResponseSsePayloadWithNative(input: {
  payload: unknown;
  streamBodyText?: string;
}): Record<string, unknown> {
  // feature_id: sse.responses_decode_projection
  // canonical_builder: build_responses_json_from_sse_json
  // canonical_builder: materialize_provider_response_sse_payload
  return callNativeJsonCapability(
    getProviderResponseNativeBindingSync,
    'materializeProviderResponseSsePayloadJson',
    [input],
    { label }
  );
}

export function resolveProviderResponseContextHelpersWithNative(input: {
  context: Record<string, unknown>;
  legacyFollowupMarkerRaw?: unknown;
  entryEndpoint?: string;
  toolSurfaceModeRaw?: string;
}): {
  isServerToolFollowup?: boolean;
  toolSurfaceShadowEnabled?: boolean;
  clientProtocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
  displayModel?: string;
  clientFacingRequestId: string;
} {
  const fn = requireNativeFunction(
    getProviderResponseNativeBindingSync,
    'resolveProviderResponseContextHelpersJson',
    { label }
  );
  const raw = fn(
    stringifyNativeJsonArg('resolveProviderResponseContextHelpersJson', input.context ?? {}, { label }),
    stringifyNativeJsonArg('resolveProviderResponseContextHelpersJson', input.legacyFollowupMarkerRaw ?? null, { label }),
    stringifyNativeJsonArg('resolveProviderResponseContextHelpersJson', typeof input.entryEndpoint === 'string' ? input.entryEndpoint : null, { label }),
    stringifyNativeJsonArg('resolveProviderResponseContextHelpersJson', input.toolSurfaceModeRaw ?? null, { label })
  );
  return parseNativeJsonResult<ReturnType<typeof resolveProviderResponseContextHelpersWithNative>>(
    'resolveProviderResponseContextHelpersJson',
    raw,
    { label }
  );
}

export function planChatProcessSessionUsageWithNative(input: {
  context: Record<string, unknown>;
  usage?: Record<string, unknown>;
}): unknown {
  return callNativeJsonCapability(
    getProviderResponseNativeBindingSync,
    'planChatProcessSessionUsageJson',
    [input ?? {}],
    { label }
  );
}

export function buildSseFramesFromJsonWithNative(input: {
  protocol: string;
  response: unknown;
  requestId: string;
  model: string;
}): NativeSseFramesOutput {
  const parsed = callNativeJsonCapability(
    getProviderResponseNativeBindingSync,
    'buildSseFramesFromJsonJson',
    [{
      protocol: input.protocol,
      response: input.response,
      request_id: input.requestId,
      model: input.model,
      config: {},
    }],
    { label }
  );
  const record = assertNativeObject('buildSseFramesFromJsonJson', parsed, { label });
  if (!Array.isArray(record.frames) || record.frames.some((frame) => typeof frame !== 'string')) {
    throw new Error('[provider-response-native-calls] native sse runtime.buildSseFramesFromJsonJson returned invalid frames');
  }
  return {
    frames: record.frames as string[],
    ...(typeof record.stats === 'object' && record.stats !== null && !Array.isArray(record.stats)
      ? { stats: record.stats as JsonObject }
      : {}),
  };
}
