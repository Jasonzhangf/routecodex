import {
  isNativeDisabledByEnv,
  makeNativeRequiredError
} from './native-router-hotpath-loader.js';
import {
  loadNativeRouterHotpathBinding,
  parseVirtualRouterNativeError
} from './native-router-hotpath-loader.js';

type PendingToolSyncPayload = {
  ready: boolean;
  insertAt: number;
};

type ContinueExecutionInjectionPayload = {
  hasDirective: boolean;
};

type ChatProcessMediaAnalysisPayload = {
  stripIndices: number[];
  containsCurrentTurnImage: boolean;
};

type ChatProcessMediaStripPayload = {
  changed: boolean;
  messages: unknown[];
};

type ChatWebSearchIntentPayload = {
  hasIntent: boolean;
  googlePreferred: boolean;
};

const NON_BLOCKING_PARSE_LOG_THROTTLE_MS = 60_000;
const nonBlockingParseLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-router-hotpath.parse-failed');

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logNativeRouterHotpathNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingParseLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_PARSE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingParseLogState.set(stage, now);
  console.warn(
    `[native-router-hotpath] ${stage} parse failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeRouterHotpathNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

function parsePendingToolSyncPayload(raw: string): PendingToolSyncPayload | null {
  const parsed = parseJson('parsePendingToolSyncPayload', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof (parsed as PendingToolSyncPayload).ready !== 'boolean') {
    return null;
  }
  const payload = parsed as PendingToolSyncPayload;
  const insertAt =
    typeof payload.insertAt === 'number' && Number.isFinite(payload.insertAt)
      ? Math.floor(payload.insertAt)
      : -1;
  return {
    ready: payload.ready,
    insertAt
  };
}

function parseContinueExecutionInjectionPayload(raw: string): ContinueExecutionInjectionPayload | null {
  const parsed = parseJson('parseContinueExecutionInjectionPayload', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof (parsed as ContinueExecutionInjectionPayload).hasDirective !== 'boolean') {
    return null;
  }
  return { hasDirective: (parsed as ContinueExecutionInjectionPayload).hasDirective };
}

function parseChatProcessMediaAnalysisPayload(raw: string): ChatProcessMediaAnalysisPayload | null {
  const parsed = parseJson('parseChatProcessMediaAnalysisPayload', raw) as {
    stripIndices?: unknown;
    containsCurrentTurnImage?: unknown;
  } | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.containsCurrentTurnImage !== 'boolean') {
    return null;
  }
  const stripIndices = Array.isArray(parsed.stripIndices)
    ? parsed.stripIndices
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
        .map((value) => Math.floor(value))
    : [];
  return {
    stripIndices,
    containsCurrentTurnImage: parsed.containsCurrentTurnImage
  };
}

function parseChatProcessMediaStripPayload(raw: string): ChatProcessMediaStripPayload | null {
  const parsed = parseJson('parseChatProcessMediaStripPayload', raw) as {
    changed?: unknown;
    messages?: unknown;
  } | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.changed !== 'boolean' || !Array.isArray(parsed.messages)) {
    return null;
  }
  return {
    changed: parsed.changed,
    messages: parsed.messages
  };
}

function parseChatWebSearchIntentPayload(raw: string): ChatWebSearchIntentPayload | null {
  const parsed = parseJson('parseChatWebSearchIntentPayload', raw) as {
    hasIntent?: unknown;
    googlePreferred?: unknown;
  } | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.hasIntent !== 'boolean' || typeof parsed.googlePreferred !== 'boolean') {
    return null;
  }
  return {
    hasIntent: parsed.hasIntent,
    googlePreferred: parsed.googlePreferred
  };
}

function toErrorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown');
}

function requireNativeFunction(capability: string, exportName: string): (...args: string[]) => unknown {
  if (isNativeDisabledByEnv()) {
    throw makeNativeRequiredError(capability, 'native disabled');
  }
  const binding = loadNativeRouterHotpathBinding() as Record<string, unknown> | null;
  const fn = binding?.[exportName];
  if (typeof fn !== 'function') {
    throw makeNativeRequiredError(capability);
  }
  return fn as (...args: string[]) => unknown;
}

export function callNativeJson<T>(
  capability: string,
  exportName: string,
  args: string[],
  parse: (raw: string) => T | null,
  options?: {
    createEmptyError?: () => Error;
    emptyReason?: string;
    invalidReason?: string;
    mapVirtualRouterErrors?: boolean;
    rethrowUnknownErrors?: boolean;
  }
): T {
  const fn = requireNativeFunction(capability, exportName);
  let raw: unknown;
  try {
    raw = fn(...args);
  } catch (error) {
    if (options?.mapVirtualRouterErrors) {
      const virtualRouterError = parseVirtualRouterNativeError(error);
      if (virtualRouterError) throw virtualRouterError;
    }
    if (options?.rethrowUnknownErrors) throw error;
    throw makeNativeRequiredError(capability, toErrorReason(error));
  }
  if (options?.mapVirtualRouterErrors) {
    const virtualRouterError = parseVirtualRouterNativeError(raw);
    if (virtualRouterError) throw virtualRouterError;
  }
  if (typeof raw !== 'string' || !raw) {
    if (options?.createEmptyError) throw options.createEmptyError();
    throw makeNativeRequiredError(capability, options?.emptyReason ?? 'empty result');
  }
  const parsed = parse(raw);
  if (!parsed) {
    throw makeNativeRequiredError(capability, options?.invalidReason ?? 'invalid payload');
  }
  return parsed;
}

export function analyzePendingToolSync(
  messages: unknown[],
  afterToolCallIds: string[]
): { ready: boolean; insertAt: number; source: 'native' } {
  const parsed = callNativeJson(
    'analyzePendingToolSyncJson',
    'analyzePendingToolSyncJson',
    [JSON.stringify(messages), JSON.stringify(afterToolCallIds)],
    parsePendingToolSyncPayload
  );
  return { ...parsed, source: 'native' };
}

export function analyzeContinueExecutionInjection(
  messages: unknown[],
  marker: string,
  targetText: string
): { hasDirective: boolean; source: 'native' } {
  const normalizedMarker = typeof marker === 'string' ? marker.trim() : '';
  const normalizedTargetText = typeof targetText === 'string' ? targetText.trim() : '';
  const parsed = callNativeJson(
    'analyzeContinueExecutionInjectionJson',
    'analyzeContinueExecutionInjectionJson',
    [JSON.stringify(messages), normalizedMarker, normalizedTargetText],
    parseContinueExecutionInjectionPayload
  );
  return { ...parsed, source: 'native' };
}

export function analyzeChatProcessMedia(messages: unknown[]): {
  stripIndices: number[]; containsCurrentTurnImage: boolean; source: 'native'
} {
  const parsed = callNativeJson(
    'analyzeChatProcessMediaJson',
    'analyzeChatProcessMediaJson',
    [JSON.stringify(messages)],
    parseChatProcessMediaAnalysisPayload
  );
  return { ...parsed, source: 'native' };
}

export function stripChatProcessHistoricalImages(messages: unknown[], placeholderText: string): {
  changed: boolean; messages: unknown[]; source: 'native'
} {
  const parsed = callNativeJson(
    'stripChatProcessHistoricalImagesJson',
    'stripChatProcessHistoricalImagesJson',
    [JSON.stringify(messages), String(placeholderText || '[Image omitted]')],
    parseChatProcessMediaStripPayload
  );
  return { ...parsed, source: 'native' };
}

export function analyzeChatWebSearchIntent(messages: unknown[]): {
  hasIntent: boolean; googlePreferred: boolean; source: 'native'
} {
  const parsed = callNativeJson(
    'analyzeChatWebSearchIntentJson',
    'analyzeChatWebSearchIntentJson',
    [JSON.stringify(messages)],
    parseChatWebSearchIntentPayload
  );
  return { ...parsed, source: 'native' };
}

export function loadNativeRouterHotpathBindingForInternalUse(): unknown {
  return loadNativeRouterHotpathBinding();
}
