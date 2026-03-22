import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

type RouterMetadataInputBuildInput = {
  requestId: string;
  entryEndpoint: string;
  processMode: 'chat' | 'passthrough';
  stream: boolean;
  direction: 'request' | 'response';
  providerProtocol: string;
  routeHint?: string;
  stage?: 'inbound' | 'outbound';
  responsesResume?: unknown;
  includeEstimatedInputTokens?: boolean;
  serverToolRequired?: boolean;
  sessionId?: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
};

type HubPipelineResultMetadataBuildInput = {
  normalized: {
    metadata: Record<string, unknown>;
    entryEndpoint: string;
    stream: boolean;
    processMode: 'chat' | 'passthrough';
    routeHint?: string;
  };
  outboundProtocol: string;
  target?: unknown;
  outboundStream?: boolean;
  capturedChatRequest: Record<string, unknown>;
  passthroughAudit?: Record<string, unknown>;
  shadowCompareBaselineMode?: 'off' | 'observe' | 'enforce';
  effectivePolicy?: { mode?: 'off' | 'observe' | 'enforce' };
  shadowBaselineProviderPayload?: Record<string, unknown>;
};

type ReqOutboundNodeResultBuildInput = {
  outboundStart: number;
  outboundEnd: number;
  messages: number;
  tools: number;
};

type ReqInboundNodeResultBuildInput = {
  inboundStart: number;
  inboundEnd: number;
  messages: number;
  tools: number;
};

type ReqInboundSkippedNodeBuildInput = { reason?: string };

type CapturedChatRequestSnapshotBuildInput = {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  parameters?: unknown;
};

type CoerceStandardizedRequestInput = {
  payload: Record<string, unknown>;
  normalized: {
    id: string;
    entryEndpoint: string;
    stream: boolean;
    processMode: 'chat' | 'passthrough';
    routeHint?: string;
  };
};

type CoerceStandardizedRequestOutput = {
  standardizedRequest: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
};

type ServertoolRuntimeMetadataBuildInput = {
  metadata?: Record<string, unknown>;
  webSearchConfig?: Record<string, unknown>;
  execCommandGuard?: Record<string, unknown>;
  clockConfig?: Record<string, unknown>;
};

type HasImageAttachmentFlagInput = {
  metadata?: Record<string, unknown>;
  hasImageAttachment: boolean;
};

type SessionIdentifiersMetadataSyncInput = {
  metadata?: Record<string, unknown>;
  sessionId?: string;
  conversationId?: string;
};

type MergeClockReservationMetadataInput = {
  processedRequest?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

type ToolGovernanceNodeResultInput = {
  success?: boolean;
  metadata?: Record<string, unknown>;
  error?: {
    code?: unknown;
    message?: unknown;
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

function parseCoerceStandardizedRequestOutput(raw: string): CoerceStandardizedRequestOutput | null {
  const parsed = parseRecord(raw);
  if (!parsed) {
    return null;
  }
  const standardizedRequest =
    parsed.standardizedRequest &&
    typeof parsed.standardizedRequest === 'object' &&
    !Array.isArray(parsed.standardizedRequest)
      ? (parsed.standardizedRequest as Record<string, unknown>)
      : null;
  const rawPayload =
    parsed.rawPayload &&
    typeof parsed.rawPayload === 'object' &&
    !Array.isArray(parsed.rawPayload)
      ? (parsed.rawPayload as Record<string, unknown>)
      : null;
  if (!standardizedRequest || !rawPayload) {
    return null;
  }
  return { standardizedRequest, rawPayload };
}

function invokeRecordCapability(
  capability: string,
  payloadFactory: () => string[] | null
): Record<string, unknown> {
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const args = payloadFactory();
  if (!args) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(...args);
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

export function buildRouterMetadataInputWithNative(input: RouterMetadataInputBuildInput): Record<string, unknown> {
  return invokeRecordCapability('buildRouterMetadataInputJson', () => {
    const inputJson = safeStringify(input ?? {});
    return inputJson ? [inputJson] : null;
  });
}

export function buildHubPipelineResultMetadataWithNative(
  input: HubPipelineResultMetadataBuildInput
): Record<string, unknown> {
  return invokeRecordCapability('buildHubPipelineResultMetadataJson', () => {
    const inputJson = safeStringify(input ?? {});
    return inputJson ? [inputJson] : null;
  });
}

export function buildReqOutboundNodeResultWithNative(
  input: ReqOutboundNodeResultBuildInput
): Record<string, unknown> {
  return invokeRecordCapability('buildReqOutboundNodeResultJson', () => {
    const inputJson = safeStringify(input ?? {});
    return inputJson ? [inputJson] : null;
  });
}

export function buildReqInboundNodeResultWithNative(input: ReqInboundNodeResultBuildInput): Record<string, unknown> {
  return invokeRecordCapability('buildReqInboundNodeResultJson', () => {
    const inputJson = safeStringify(input ?? {});
    return inputJson ? [inputJson] : null;
  });
}

export function buildReqInboundSkippedNodeWithNative(input: ReqInboundSkippedNodeBuildInput): Record<string, unknown> {
  return invokeRecordCapability('buildReqInboundSkippedNodeJson', () => {
    const inputJson = safeStringify(input ?? {});
    return inputJson ? [inputJson] : null;
  });
}

export function buildCapturedChatRequestSnapshotWithNative(
  input: CapturedChatRequestSnapshotBuildInput
): Record<string, unknown> {
  return invokeRecordCapability('buildCapturedChatRequestSnapshotJson', () => {
    const inputJson = safeStringify(input ?? {});
    return inputJson ? [inputJson] : null;
  });
}

export function coerceStandardizedRequestFromPayloadWithNative(
  input: CoerceStandardizedRequestInput
): CoerceStandardizedRequestOutput {
  const capability = 'coerceStandardizedRequestFromPayloadJson';
  const fail = (reason?: string): CoerceStandardizedRequestOutput =>
    failNativeRequired<CoerceStandardizedRequestOutput>(capability, reason);

  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? {});
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseCoerceStandardizedRequestOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function prepareRuntimeMetadataForServertoolsWithNative(
  input: ServertoolRuntimeMetadataBuildInput
): Record<string, unknown> {
  return invokeRecordCapability('prepareRuntimeMetadataForServertoolsJson', () => {
    const inputJson = safeStringify(input ?? {});
    return inputJson ? [inputJson] : null;
  });
}

export function applyHasImageAttachmentFlagWithNative(input: HasImageAttachmentFlagInput): Record<string, unknown> {
  return invokeRecordCapability('applyHasImageAttachmentFlagJson', () => {
    const inputJson = safeStringify(input ?? {});
    return inputJson ? [inputJson] : null;
  });
}

export function syncSessionIdentifiersToMetadataWithNative(
  input: SessionIdentifiersMetadataSyncInput
): Record<string, unknown> {
  return invokeRecordCapability('syncSessionIdentifiersToMetadataJson', () => {
    const inputJson = safeStringify(input ?? {});
    return inputJson ? [inputJson] : null;
  });
}

export function mergeClockReservationIntoMetadataWithNative(
  input: MergeClockReservationMetadataInput
): Record<string, unknown> {
  return invokeRecordCapability('mergeClockReservationIntoMetadataJson', () => {
    const inputJson = safeStringify(input ?? {});
    return inputJson ? [inputJson] : null;
  });
}

export function buildToolGovernanceNodeResultWithNative(
  input: ToolGovernanceNodeResultInput
): Record<string, unknown> {
  return invokeRecordCapability('buildToolGovernanceNodeResultJson', () => {
    const inputJson = safeStringify(input ?? {});
    return inputJson ? [inputJson] : null;
  });
}

export function buildPassthroughGovernanceSkippedNodeWithNative(): Record<string, unknown> {
  const capability = 'buildPassthroughGovernanceSkippedNodeJson';
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn();
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
