import { createRequire } from 'node:module';
import path from 'node:path';

const nodeRequire = createRequire(import.meta.url);
let nativeBinding = null;

function candidateNativePaths() {
  return [
    path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/rust-core/target/release/router_hotpath_napi.node'),
    path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/rust-core/target/debug/router_hotpath_napi.node'),
    path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node'),
  ];
}

function getNativeBinding() {
  if (nativeBinding) return nativeBinding;
  const failures = [];
  for (const candidate of candidateNativePaths()) {
    try {
      nativeBinding = nodeRequire(candidate);
      if (nativeBinding && typeof nativeBinding === 'object') {
        return nativeBinding;
      }
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`router_hotpath_napi native binding not found:\n${failures.join('\n')}`);
}

function nativeFn(name) {
  const fn = getNativeBinding()[name];
  if (typeof fn !== 'function') {
    throw new Error(`${name} native export is required`);
  }
  return fn;
}

function parseNativeRecord(raw, capability) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${capability} returned invalid payload`);
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} returned non-object payload`);
  }
  return parsed;
}

function executeResponsesStoreOperation(operation, payload = {}) {
  const parsed = parseNativeRecord(
    nativeFn('executeResponsesConversationStoreOperationJson')(
      JSON.stringify({
        operation,
        payload,
        persistenceFilePath: process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE,
      }),
    ),
    'executeResponsesConversationStoreOperationJson',
  );
  if (parsed.ok === false) {
    const error = parsed.error && typeof parsed.error === 'object' ? parsed.error : {};
    throw new Error(String(error.message ?? `${operation} responses store operation failed`));
  }
  if (parsed.ok !== true) {
    throw new Error('executeResponsesConversationStoreOperationJson returned invalid envelope');
  }
  return parsed.result;
}

export function getHubPipelineVirtualRouterStatusNative(handle) {
  if (typeof handle !== 'string' || handle.length === 0) {
    throw new Error('getHubPipelineVirtualRouterStatusNative requires non-empty handle');
  }
  return parseNativeRecord(
    nativeFn('hubPipelineVirtualRouterStatusJson')(handle),
    'hubPipelineVirtualRouterStatusJson',
  );
}

export function captureResponsesRequestContextForRequest(args) {
  executeResponsesStoreOperation('capture_request_context', args);
}

export function recordResponsesResponseForRequest(args) {
  executeResponsesStoreOperation('record_response', args);
}

export function getResponsesConversationStoreDebugStats() {
  return executeResponsesStoreOperation('debug_stats');
}
