import { createRequire } from 'node:module';
import path from 'node:path';

const nodeRequire = createRequire(import.meta.url);
let nativeBinding = null;

function candidateNativePaths() {
  const candidates = [
    path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node'),
  ];
  for (const specifier of ['rcc-llmswitch-core', '@jsonstudio/llms']) {
    try {
      const mainPath = nodeRequire.resolve(specifier);
      const packageRoot = mainPath.endsWith(`${path.sep}dist${path.sep}index.js`)
        ? path.dirname(path.dirname(mainPath))
        : path.dirname(mainPath);
      candidates.push(
        path.join(packageRoot, 'dist', 'native', 'router_hotpath_napi.node'),
        path.join(packageRoot, 'router_hotpath_napi.node'),
      );
    } catch {
      // Source checkout scripts do not require an installed package.
    }
  }
  return [...new Set(candidates)];
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

export function buildOpenAIChatFromAnthropicFull(payload, options = {}) {
  return parseNativeRecord(
    nativeFn('buildOpenaiChatFromAnthropicJson')(
      JSON.stringify(payload ?? {}),
      JSON.stringify(options ?? {}),
    ),
    'buildOpenaiChatFromAnthropicJson',
  );
}

export function buildOpenAIChatFromAnthropic(payload, options = {}) {
  const full = buildOpenAIChatFromAnthropicFull(payload, options);
  return full.request && typeof full.request === 'object' && !Array.isArray(full.request)
    ? full.request
    : {};
}

export function buildAnthropicRequestFromOpenAIChat(payload, options = {}) {
  return parseNativeRecord(
    nativeFn('buildAnthropicFromOpenaiChatJson')(
      JSON.stringify(payload ?? {}),
      JSON.stringify(options ?? {}),
    ),
    'buildAnthropicFromOpenaiChatJson',
  );
}

export const buildAnthropicFromOpenAIChat = buildAnthropicRequestFromOpenAIChat;

export function convertAnthropicRequest(payload, context = {}) {
  const full = buildOpenAIChatFromAnthropicFull(payload, { includeToolCallIds: true });
  const aliasMap = full.anthropicToolNameMap;
  if (aliasMap && typeof aliasMap === 'object' && !Array.isArray(aliasMap)) {
    context.metadata = context.metadata ?? {};
    context.metadata.anthropicToolNameMap = aliasMap;
  }
  return full.request && typeof full.request === 'object' && !Array.isArray(full.request)
    ? full.request
    : {};
}

export function convertAnthropicResponse(payload, context = {}) {
  const aliasMap =
    context.metadata && typeof context.metadata === 'object'
      ? context.metadata.anthropicToolNameMap
      : undefined;
  return buildAnthropicFromOpenAIChat(payload, {
    toolNameMap: aliasMap,
    requestId: context.requestId,
    entryEndpoint: context.entryEndpoint ?? context.endpoint,
  });
}

export function buildOpenAIChatFromAnthropicMessageResponse(payload) {
  const output = nativeFn('buildOpenaiChatResponseFromAnthropicMessageJson')(
    JSON.stringify(payload ?? {}),
    undefined,
  );
  return parseNativeRecord(output, 'buildOpenaiChatResponseFromAnthropicMessageJson');
}

export function buildAnthropicResponseFromChatResponse(chatResponse, options = {}) {
  const output = nativeFn('buildAnthropicResponseFromChatFullJson')(JSON.stringify({
    chat_response: JSON.stringify(chatResponse ?? {}),
    alias_map: options?.aliasMap ? JSON.stringify(options.aliasMap) : undefined,
  }));
  const parsed = parseNativeRecord(output, 'buildAnthropicResponseFromChatFullJson');
  return JSON.parse(parsed.result);
}
