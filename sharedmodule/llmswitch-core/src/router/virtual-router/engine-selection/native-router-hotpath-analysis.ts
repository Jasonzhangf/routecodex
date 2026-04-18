export type PendingToolSyncPayload = {
  ready: boolean;
  insertAt: number;
};

export type ContinueExecutionInjectionPayload = {
  hasDirective: boolean;
};

export type ChatProcessMediaAnalysisPayload = {
  stripIndices: number[];
  containsCurrentTurnImage: boolean;
};

export type ChatProcessMediaStripPayload = {
  changed: boolean;
  messages: unknown[];
};

export type ChatWebSearchIntentPayload = {
  hasIntent: boolean;
  googlePreferred: boolean;
};

export type ClockClearDirectivePayload = {
  hadClear: boolean;
  next: string;
};

export type ProviderKeyParsePayload = {
  providerId: string | null;
  alias: string | null;
  keyIndex?: number;
};

export type AntigravitySessionIdPayload = {
  sessionId: string;
};

export type AntigravityPinnedAliasLookupPayload = {
  alias?: string;
};

export type AntigravityPinnedAliasUnpinPayload = {
  changed: boolean;
};

export type AntigravityCacheSignaturePayload = {
  ok: boolean;
};

export type AntigravityRequestSessionMetaPayload = {
  aliasKey?: string;
  sessionId?: string;
  messageCount?: number;
};

const NON_BLOCKING_PARSE_LOG_THROTTLE_MS = 60_000;
const nonBlockingParseLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-router-hotpath-analysis.parse-failed');

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? 'unknown');
  }
}

function logNativeRouterHotpathAnalysisNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingParseLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_PARSE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingParseLogState.set(stage, now);
  console.warn(
    `[native-router-hotpath-analysis] ${stage} parse failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeRouterHotpathAnalysisNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

export function parsePendingToolSyncPayload(raw: string): PendingToolSyncPayload | null {
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

export function parseContinueExecutionInjectionPayload(raw: string): ContinueExecutionInjectionPayload | null {
  const parsed = parseJson('parseContinueExecutionInjectionPayload', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof (parsed as ContinueExecutionInjectionPayload).hasDirective !== 'boolean') {
    return null;
  }
  return { hasDirective: (parsed as ContinueExecutionInjectionPayload).hasDirective };
}

export function parseChatProcessMediaAnalysisPayload(raw: string): ChatProcessMediaAnalysisPayload | null {
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

export function parseChatProcessMediaStripPayload(raw: string): ChatProcessMediaStripPayload | null {
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

export function parseChatWebSearchIntentPayload(raw: string): ChatWebSearchIntentPayload | null {
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

export function parseClockClearDirectivePayload(raw: string): ClockClearDirectivePayload | null {
  const parsed = parseJson('parseClockClearDirectivePayload', raw) as {
    hadClear?: unknown;
    next?: unknown;
  } | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.hadClear !== 'boolean' || typeof parsed.next !== 'string') {
    return null;
  }
  return {
    hadClear: parsed.hadClear,
    next: parsed.next
  };
}

export function parseProviderKeyPayload(raw: string): ProviderKeyParsePayload | null {
  const parsed = parseJson('parseProviderKeyPayload', raw) as {
    providerId?: unknown;
    alias?: unknown;
    keyIndex?: unknown;
  } | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object') {
    return null;
  }
  const providerId =
    typeof parsed.providerId === 'string'
      ? parsed.providerId
      : parsed.providerId === null
        ? null
        : null;
  const alias =
    typeof parsed.alias === 'string'
      ? parsed.alias
      : parsed.alias === null
        ? null
        : null;
  const keyIndex =
    typeof parsed.keyIndex === 'number' && Number.isFinite(parsed.keyIndex)
      ? Math.floor(parsed.keyIndex)
      : undefined;
  return {
    providerId,
    alias,
    ...(keyIndex !== undefined ? { keyIndex } : {})
  };
}

export function parseAntigravitySessionIdPayload(raw: string): AntigravitySessionIdPayload | null {
  const parsed = parseJson('parseAntigravitySessionIdPayload', raw);
  if (parsed === JSON_PARSE_FAILED || typeof parsed !== 'string') {
    return null;
  }
  const sessionId = parsed.trim();
  if (!sessionId) {
    return null;
  }
  return { sessionId };
}

export function parseAntigravityPinnedAliasLookupPayload(raw: string): AntigravityPinnedAliasLookupPayload | null {
  const parsed = parseJson('parseAntigravityPinnedAliasLookupPayload', raw) as
    | { alias?: unknown }
    | null
    | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  if (parsed.alias === undefined || parsed.alias === null) {
    return {};
  }
  if (typeof parsed.alias !== 'string') {
    return null;
  }
  const alias = parsed.alias.trim();
  if (!alias) {
    return {};
  }
  return { alias };
}

export function parseAntigravityPinnedAliasUnpinPayload(raw: string): AntigravityPinnedAliasUnpinPayload | null {
  const parsed = parseJson('parseAntigravityPinnedAliasUnpinPayload', raw) as
    | { changed?: unknown }
    | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.changed !== 'boolean') {
    return null;
  }
  return { changed: parsed.changed };
}

export function parseAntigravityCacheSignaturePayload(raw: string): AntigravityCacheSignaturePayload | null {
  const parsed = parseJson('parseAntigravityCacheSignaturePayload', raw) as
    | { ok?: unknown }
    | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.ok !== 'boolean') {
    return null;
  }
  return { ok: parsed.ok };
}

export function parseAntigravityRequestSessionMetaPayload(raw: string): AntigravityRequestSessionMetaPayload | null {
  const parsed = parseJson('parseAntigravityRequestSessionMetaPayload', raw) as
    | {
        aliasKey?: unknown;
        sessionId?: unknown;
        messageCount?: unknown;
      }
    | null
    | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const aliasKey =
    typeof parsed.aliasKey === 'string' && parsed.aliasKey.trim().length
      ? parsed.aliasKey.trim()
      : undefined;
  const sessionId =
    typeof parsed.sessionId === 'string' && parsed.sessionId.trim().length
      ? parsed.sessionId.trim()
      : undefined;
  const messageCount =
    typeof parsed.messageCount === 'number' && Number.isFinite(parsed.messageCount) && parsed.messageCount > 0
      ? Math.floor(parsed.messageCount)
      : undefined;
  return {
    ...(aliasKey ? { aliasKey } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(messageCount !== undefined ? { messageCount } : {})
  };
}
