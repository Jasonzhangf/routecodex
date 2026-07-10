import {
  callNativeJson,
  loadNativeRouterHotpathBindingForInternalUse
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
const JSON_PARSE_FAILED = Symbol('native-router-hotpath-direct-native.parse-failed');

function logParseFailure(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingParseLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_PARSE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingParseLogState.set(stage, now);
  const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
  console.warn(`[native-router-hotpath-direct-native] ${stage} parse failed (non-blocking): ${reason}`);
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logParseFailure(stage, error);
    return JSON_PARSE_FAILED;
  }
}

function parsePendingToolSyncPayload(raw: string): PendingToolSyncPayload | null {
  const parsed = parseJson('parsePendingToolSyncPayload', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof (parsed as PendingToolSyncPayload).ready !== 'boolean') {
    return null;
  }
  const payload = parsed as PendingToolSyncPayload;
  return {
    ready: payload.ready,
    insertAt: typeof payload.insertAt === 'number' && Number.isFinite(payload.insertAt)
      ? Math.floor(payload.insertAt)
      : -1
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
  return {
    stripIndices: Array.isArray(parsed.stripIndices)
      ? parsed.stripIndices
          .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
          .map((value) => Math.floor(value))
      : [],
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
  return { changed: parsed.changed, messages: parsed.messages };
}

function parseChatWebSearchIntentPayload(raw: string): ChatWebSearchIntentPayload | null {
  const parsed = parseJson('parseChatWebSearchIntentPayload', raw) as {
    hasIntent?: unknown;
    googlePreferred?: unknown;
  } | typeof JSON_PARSE_FAILED;
  if (
    parsed === JSON_PARSE_FAILED
    || !parsed
    || typeof parsed.hasIntent !== 'boolean'
    || typeof parsed.googlePreferred !== 'boolean'
  ) {
    return null;
  }
  return {
    hasIntent: parsed.hasIntent,
    googlePreferred: parsed.googlePreferred
  };
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
  const parsed = callNativeJson(
    'analyzeContinueExecutionInjectionJson',
    'analyzeContinueExecutionInjectionJson',
    [JSON.stringify(messages), marker.trim(), targetText.trim()],
    parseContinueExecutionInjectionPayload
  );
  return { ...parsed, source: 'native' };
}

export function analyzeChatProcessMedia(messages: unknown[]): ChatProcessMediaAnalysisPayload & { source: 'native' } {
  const parsed = callNativeJson(
    'analyzeChatProcessMediaJson',
    'analyzeChatProcessMediaJson',
    [JSON.stringify(messages)],
    parseChatProcessMediaAnalysisPayload
  );
  return { ...parsed, source: 'native' };
}

export function stripChatProcessHistoricalImages(
  messages: unknown[],
  placeholderText: string
): ChatProcessMediaStripPayload & { source: 'native' } {
  const parsed = callNativeJson(
    'stripChatProcessHistoricalImagesJson',
    'stripChatProcessHistoricalImagesJson',
    [JSON.stringify(messages), String(placeholderText || '[Image omitted]')],
    parseChatProcessMediaStripPayload
  );
  return { ...parsed, source: 'native' };
}

export function analyzeChatWebSearchIntent(messages: unknown[]): ChatWebSearchIntentPayload & { source: 'native' } {
  const parsed = callNativeJson(
    'analyzeChatWebSearchIntentJson',
    'analyzeChatWebSearchIntentJson',
    [JSON.stringify(messages)],
    parseChatWebSearchIntentPayload
  );
  return { ...parsed, source: 'native' };
}

export { loadNativeRouterHotpathBindingForInternalUse };
