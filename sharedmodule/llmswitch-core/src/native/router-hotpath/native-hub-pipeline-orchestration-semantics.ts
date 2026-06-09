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
  processMode: 'chat';
  direction: 'request' | 'response';
  stage: 'inbound' | 'outbound';
}

function readNativeFunction(name: string): ((...args: string[]) => string) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null | undefined;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: string[]) => string) : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export interface NativeHubPipelineOrchestrationOutput {
  requestId: string;
  success: boolean;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  standardizedRequest?: Record<string, unknown>;
  entryOriginRequest?: Record<string, unknown>;
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


export interface NativeRouterMetadataInputBuildInput {
  requestId: string;
  entryEndpoint: string;
  processMode: 'chat';
  stream: boolean;
  direction: 'request' | 'response';
  providerProtocol: string;
  routeHint?: string;
  stage?: 'inbound' | 'outbound';
  responsesResume?: unknown;
  requestSemantics?: unknown;
  includeEstimatedInputTokens?: boolean;
  serverToolRequired?: boolean;
  sessionId?: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
}


export interface NativeCoerceStandardizedRequestInput {
  payload: Record<string, unknown>;
  normalized: {
    id: string;
    entryEndpoint: string;
    stream: boolean;
    processMode: 'chat';
    routeHint?: string;
  };
}

export interface NativeCoerceStandardizedRequestOutput {
  standardizedRequest: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
}


export {
  extractModelHintFromMetadataWithNative,
  normalizeHubEndpointWithNative,
  resolveSseProtocolWithNative,
  planProviderResponseServertoolRuntimeActionsWithNative,
  runHubPipelineOrchestrationWithNative
} from './native-hub-pipeline-orchestration-semantics-protocol.js';

export {
  resolveStopMessageRouterMetadataWithNative
} from './native-hub-pipeline-orchestration-semantics-metadata-policy.js';

export {
  buildRouterMetadataInputWithNative,
  coerceStandardizedRequestFromPayloadWithNative
} from './native-hub-pipeline-orchestration-semantics-builders.js';


function parseStringArray(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.every((entry) => typeof entry === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

export function findMappableSemanticsKeysWithNative(metadata: unknown): string[] {
  const capability = 'findMappableSemanticsKeysJson';
  const fail = (reason?: string): string[] => failNativeRequired<string[]>(capability, reason);
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const metadataJson = safeStringify(metadata ?? null);
  if (!metadataJson) return fail('json stringify failed');
  try {
    const raw = fn(metadataJson);
    if (typeof raw !== 'string' || !raw) return fail('empty result');
    return parseStringArray(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
