import { createRequire } from 'node:module';
import path from 'node:path';

const nodeRequire = createRequire(import.meta.url);
let nativeBinding = null;

function candidateNativePaths() {
  return [
    path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node'),
    path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/rust-core/target/release/router_hotpath_napi.node'),
    path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/rust-core/target/debug/router_hotpath_napi.node'),
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

function stringifyArg(value) {
  return JSON.stringify(value ?? null);
}

export function buildResponsesPayloadFromChatNative(payload, context = {}) {
  return parseNativeRecord(
    nativeFn('buildResponsesPayloadFromChatJson')(
      stringifyArg(payload),
      stringifyArg(context),
    ),
    'buildResponsesPayloadFromChatJson',
  );
}

export function buildResponsesRequestFromChatNative(payload, context = {}, extras = {}) {
  const parsed = parseNativeRecord(
    nativeFn('buildResponsesRequestFromChatJson')(
      stringifyArg({ payload: payload ?? {}, context: context ?? null, extras: extras ?? null }),
    ),
    'buildResponsesRequestFromChatJson',
  );
  if (!parsed.request || typeof parsed.request !== 'object' || Array.isArray(parsed.request)) {
    throw new Error('buildResponsesRequestFromChatJson returned invalid request');
  }
  return parsed;
}

export function convertResponsesRequestToChatNative(payload, options = {}) {
  return parseNativeRecord(
    nativeFn('runResponsesOpenaiRequestCodecJson')(
      stringifyArg(payload ?? {}),
      stringifyArg(options ?? {}),
    ),
    'runResponsesOpenaiRequestCodecJson',
  );
}

export function captureReqInboundResponsesContextSnapshotJson(input) {
  return parseNativeRecord(
    nativeFn('captureReqInboundResponsesContextSnapshotJson')(
      stringifyArg(input ?? {}),
    ),
    'captureReqInboundResponsesContextSnapshotJson',
  );
}

export function normalizeAssistantTextToToolCallsJson(message, options = {}) {
  return parseNativeRecord(
    nativeFn('normalizeAssistantTextToToolCallsJson')(
      stringifyArg(message ?? {}),
      stringifyArg(options ?? {}),
    ),
    'normalizeAssistantTextToToolCallsJson',
  );
}

export function buildChatResponseFromResponsesDirectNative(payload) {
  return parseNativeRecord(
    nativeFn('buildChatResponseFromResponsesJson')(stringifyArg(payload)),
    'buildChatResponseFromResponsesJson',
  );
}
