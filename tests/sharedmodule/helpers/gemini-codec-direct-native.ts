import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const nativeBinding = nodeRequire(
  path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')
) as Record<string, unknown>;

function nativeFn(name: string): (...args: unknown[]) => unknown {
  const fn = nativeBinding[name];
  if (typeof fn !== 'function') {
    throw new Error(`${name} native export is required`);
  }
  return fn as (...args: unknown[]) => unknown;
}

function parseNativeRecord(raw: unknown, capability: string): Record<string, unknown> {
  if (raw instanceof Error) {
    throw raw;
  }
  if (raw && typeof raw === 'object' && 'message' in raw) {
    const message = (raw as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) {
      throw new Error(message);
    }
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${capability} returned invalid payload`);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} returned non-object payload`);
  }
  return parsed as Record<string, unknown>;
}

function unwrapProviderProtocolError(result: Record<string, unknown>): void {
  const raw = result.__providerProtocolError;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return;
  }
  const error = raw as Record<string, unknown>;
  throw new Error(String(error.message ?? 'Gemini provider protocol error'));
}

export function buildOpenAIChatFromGeminiRequestDirectNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return parseNativeRecord(
    nativeFn('runGeminiOpenaiRequestCodecJson')(
      JSON.stringify(payload ?? {}),
      JSON.stringify(options ?? {}),
    ),
    'runGeminiOpenaiRequestCodecJson',
  );
}

export function buildOpenAIChatFromGeminiResponseDirectNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  const result = parseNativeRecord(
    nativeFn('runGeminiOpenaiResponseCodecJson')(
      JSON.stringify(payload ?? {}),
      JSON.stringify(options ?? {}),
    ),
    'runGeminiOpenaiResponseCodecJson',
  );
  unwrapProviderProtocolError(result);
  return result;
}

export function buildGeminiFromOpenAIChatDirectNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return parseNativeRecord(
    nativeFn('runGeminiFromOpenaiChatCodecJson')(
      JSON.stringify(payload ?? {}),
      JSON.stringify(options ?? {}),
    ),
    'runGeminiFromOpenaiChatCodecJson',
  );
}

export function convertGeminiRequestDirectNative(payload: Record<string, unknown>): Record<string, unknown> {
  return buildOpenAIChatFromGeminiRequestDirectNative(payload);
}

export function convertGeminiResponseDirectNative(payload: Record<string, unknown>): Record<string, unknown> {
  return buildGeminiFromOpenAIChatDirectNative(payload);
}
