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

export function runResponsesOpenAIRequestCodecDirectNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return parseNativeRecord(
    nativeFn('runResponsesOpenaiRequestCodecJson')(
      JSON.stringify(payload ?? {}),
      JSON.stringify(options ?? {}),
    ),
    'runResponsesOpenaiRequestCodecJson',
  );
}

export function runResponsesOpenAIResponseCodecDirectNative(
  payload: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  return parseNativeRecord(
    nativeFn('runResponsesOpenaiResponseCodecJson')(
      JSON.stringify(payload ?? {}),
      JSON.stringify(context ?? {}),
    ),
    'runResponsesOpenaiResponseCodecJson',
  );
}

export function requestContextFromNativeResult(
  result: Record<string, unknown>,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  const context = result.context && typeof result.context === 'object' && !Array.isArray(result.context)
    ? (result.context as Record<string, unknown>)
    : {};
  return { ...context, ...extras };
}
