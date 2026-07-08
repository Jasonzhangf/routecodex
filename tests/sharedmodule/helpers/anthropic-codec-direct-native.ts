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
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${capability} returned invalid payload`);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} returned non-object payload`);
  }
  return parsed as Record<string, unknown>;
}

export function buildOpenAIChatFromAnthropicFullDirectNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return parseNativeRecord(
    nativeFn('buildOpenaiChatFromAnthropicJson')(
      JSON.stringify(payload ?? {}),
      JSON.stringify(options ?? {}),
    ),
    'buildOpenaiChatFromAnthropicJson',
  );
}

export function buildOpenAIChatFromAnthropicDirectNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  const full = buildOpenAIChatFromAnthropicFullDirectNative(payload, options);
  return full.request && typeof full.request === 'object' && !Array.isArray(full.request)
    ? (full.request as Record<string, unknown>)
    : {};
}

export function buildAnthropicFromOpenAIChatDirectNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return parseNativeRecord(
    nativeFn('buildAnthropicFromOpenaiChatJson')(
      JSON.stringify(payload ?? {}),
      JSON.stringify(options ?? {}),
    ),
    'buildAnthropicFromOpenaiChatJson',
  );
}

export function convertAnthropicRequestDirectNative(
  payload: Record<string, unknown>,
  context: { metadata?: Record<string, unknown> },
): Record<string, unknown> {
  const full = buildOpenAIChatFromAnthropicFullDirectNative(payload, { includeToolCallIds: true });
  const aliasMap = full.anthropicToolNameMap;
  if (aliasMap && typeof aliasMap === 'object' && !Array.isArray(aliasMap)) {
    context.metadata = context.metadata ?? {};
    context.metadata.anthropicToolNameMap = aliasMap;
  }
  return full.request && typeof full.request === 'object' && !Array.isArray(full.request)
    ? (full.request as Record<string, unknown>)
    : {};
}

export function convertAnthropicResponseDirectNative(
  payload: Record<string, unknown>,
  context: { requestId?: string; endpoint?: string; entryEndpoint?: string; metadata?: Record<string, unknown> },
): Record<string, unknown> {
  const aliasMap =
    context.metadata && typeof context.metadata === 'object'
      ? (context.metadata.anthropicToolNameMap as Record<string, string> | undefined)
      : undefined;
  return buildAnthropicFromOpenAIChatDirectNative(payload, {
    toolNameMap: aliasMap,
    requestId: context.requestId,
    entryEndpoint: context.entryEndpoint ?? context.endpoint,
  });
}
