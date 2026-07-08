import { readNativeFunction } from './native-shared-conversion-semantics-core.js';

// feature_id: hub.runtime_ingress_bridge

export interface NativeHubPipelineOrchestrationInput {
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
  stage: 'inbound' | 'outbound';
}

export interface NativeHubPipelineOrchestrationOutput {
  requestId: string;
  success: boolean;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  standardizedRequest?: Record<string, unknown>;
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
  metadataCenterSnapshot?: {
    requestTruth?: Record<string, unknown>;
    continuationContext?: Record<string, unknown>;
    runtimeControl?: Record<string, unknown>;
  };
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
  buildHubPipelineMaterializedRequestPlanWithNative,
  normalizeHubEndpointWithNative,
  resolveSseProtocolWithNative,
  runHubPipelineOrchestrationWithNative
} from './native-hub-pipeline-orchestration-semantics-protocol.js';

export {
  resolveStopMessageRouterMetadataWithNative
} from './native-hub-pipeline-orchestration-semantics-metadata-policy.js';

export {
  buildRouterMetadataInputWithNative,
  coerceStandardizedRequestFromPayloadWithNative
} from './native-hub-pipeline-orchestration-semantics-builders.js';

// ---- HubPipeline engine handle exports ----

type NativeFunction1<A, R> = (arg: A) => R;
type NativeFunction2<A, B, R> = (arg1: A, arg2: B) => R;

function requireNativeHotpathFn<T extends (...args: unknown[]) => unknown>(capability: string): T {
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error(`${capability} native export is required`);
  }
  return fn as T;
}

export function createHubPipelineEngineJson(inputJson: string): string {
  const fn = requireNativeHotpathFn<NativeFunction1<string, string>>('createHubPipelineEngineJson');
  return fn(inputJson);
}

export function hubPipelineExecuteJson(handle: string, requestJson: string): string {
  const fn = requireNativeHotpathFn<NativeFunction2<string, string, string>>('hubPipelineExecuteJson');
  return fn(handle, requestJson);
}

export function disposeHubPipelineEngineJson(handle: string): void {
  const fn = requireNativeHotpathFn<NativeFunction1<string, void>>('disposeHubPipelineEngineJson');
  fn(handle);
}

export function updateHubPipelineVirtualRouterConfigJson(handle: string, configJson: string): void {
  const fn = requireNativeHotpathFn<NativeFunction2<string, string, void>>('updateHubPipelineVirtualRouterConfigJson');
  fn(handle, configJson);
}

export function updateHubPipelineEngineDepsJson(handle: string, depsJson: string): void {
  const fn = requireNativeHotpathFn<NativeFunction2<string, string, void>>('updateHubPipelineEngineDepsJson');
  fn(handle, depsJson);
}

export function hubPipelineVirtualRouterRouteJson(
  handle: string,
  requestJson: string,
  metadataJson: string
): string {
  const fn = requireNativeHotpathFn<(arg1: string, arg2: string, arg3: string) => string>('hubPipelineVirtualRouterRouteJson');
  return fn(handle, requestJson, metadataJson);
}

export function hubPipelineVirtualRouterDiagnoseRouteJson(
  handle: string,
  requestJson: string,
  metadataJson: string
): string {
  const fn = requireNativeHotpathFn<(arg1: string, arg2: string, arg3: string) => string>('hubPipelineVirtualRouterDiagnoseRouteJson');
  return fn(handle, requestJson, metadataJson);
}

export function hubPipelineVirtualRouterStatusJson(handle: string): string {
  const fn = requireNativeHotpathFn<NativeFunction1<string, string>>('hubPipelineVirtualRouterStatusJson');
  return fn(handle);
}

export function hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson(
  handle: string,
  scopeKey: string
): void {
  const fn = requireNativeHotpathFn<NativeFunction2<string, string, void>>('hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson');
  fn(handle, scopeKey);
}

export function hubPipelineVirtualRouterMarkConcurrencyScopeIdleJson(
  handle: string,
  scopeKey: string
): void {
  const fn = requireNativeHotpathFn<NativeFunction2<string, string, void>>('hubPipelineVirtualRouterMarkConcurrencyScopeIdleJson');
  fn(handle, scopeKey);
}
