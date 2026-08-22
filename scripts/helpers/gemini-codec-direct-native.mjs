import { createRequire } from 'node:module';
import path from 'node:path';

const nodeRequire = createRequire(import.meta.url);
let nativeBinding = null;

function candidateNativePaths() {
  return [
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
  if (raw instanceof Error) {
    throw raw;
  }
  if (raw && typeof raw === 'object' && typeof raw.message === 'string') {
    throw new Error(raw.message);
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${capability} returned invalid payload`);
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} returned non-object payload`);
  }
  return parsed;
}

export function buildOpenAIChatFromGeminiRequest(payload, options = {}) {
  return parseNativeRecord(
    nativeFn('runGeminiOpenaiRequestCodecJson')(
      JSON.stringify(payload ?? {}),
      JSON.stringify(options ?? {}),
    ),
    'runGeminiOpenaiRequestCodecJson',
  );
}

export function buildOpenAIChatFromGeminiResponse(payload, options = {}) {
  const result = parseNativeRecord(
    nativeFn('runGeminiOpenaiResponseCodecJson')(
      JSON.stringify(payload ?? {}),
      JSON.stringify(options ?? {}),
    ),
    'runGeminiOpenaiResponseCodecJson',
  );
  const error = result.__providerProtocolError;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    throw new Error(String(error.message ?? 'Gemini provider protocol error'));
  }
  return result;
}

export function buildGeminiFromOpenAIChat(payload, options = {}) {
  return parseNativeRecord(
    nativeFn('runGeminiFromOpenaiChatCodecJson')(
      JSON.stringify(payload ?? {}),
      JSON.stringify(options ?? {}),
    ),
    'runGeminiFromOpenaiChatCodecJson',
  );
}
