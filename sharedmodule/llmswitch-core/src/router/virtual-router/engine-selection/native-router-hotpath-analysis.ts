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

export function parsePendingToolSyncPayload(raw: string): PendingToolSyncPayload | null {
  try {
    const parsed = JSON.parse(raw) as PendingToolSyncPayload;
    if (!parsed || typeof parsed.ready !== 'boolean') {
      return null;
    }
    const insertAt =
      typeof parsed.insertAt === 'number' && Number.isFinite(parsed.insertAt)
        ? Math.floor(parsed.insertAt)
        : -1;
    return {
      ready: parsed.ready,
      insertAt
    };
  } catch {
    return null;
  }
}

export function parseContinueExecutionInjectionPayload(raw: string): ContinueExecutionInjectionPayload | null {
  try {
    const parsed = JSON.parse(raw) as ContinueExecutionInjectionPayload;
    if (!parsed || typeof parsed.hasDirective !== 'boolean') {
      return null;
    }
    return { hasDirective: parsed.hasDirective };
  } catch {
    return null;
  }
}

export function parseChatProcessMediaAnalysisPayload(raw: string): ChatProcessMediaAnalysisPayload | null {
  try {
    const parsed = JSON.parse(raw) as {
      stripIndices?: unknown;
      containsCurrentTurnImage?: unknown;
    };
    if (!parsed || typeof parsed.containsCurrentTurnImage !== 'boolean') {
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
  } catch {
    return null;
  }
}

export function parseChatProcessMediaStripPayload(raw: string): ChatProcessMediaStripPayload | null {
  try {
    const parsed = JSON.parse(raw) as {
      changed?: unknown;
      messages?: unknown;
    };
    if (!parsed || typeof parsed.changed !== 'boolean' || !Array.isArray(parsed.messages)) {
      return null;
    }
    return {
      changed: parsed.changed,
      messages: parsed.messages
    };
  } catch {
    return null;
  }
}

export function parseChatWebSearchIntentPayload(raw: string): ChatWebSearchIntentPayload | null {
  try {
    const parsed = JSON.parse(raw) as {
      hasIntent?: unknown;
      googlePreferred?: unknown;
    };
    if (!parsed || typeof parsed.hasIntent !== 'boolean' || typeof parsed.googlePreferred !== 'boolean') {
      return null;
    }
    return {
      hasIntent: parsed.hasIntent,
      googlePreferred: parsed.googlePreferred
    };
  } catch {
    return null;
  }
}

export function parseClockClearDirectivePayload(raw: string): ClockClearDirectivePayload | null {
  try {
    const parsed = JSON.parse(raw) as {
      hadClear?: unknown;
      next?: unknown;
    };
    if (!parsed || typeof parsed.hadClear !== 'boolean' || typeof parsed.next !== 'string') {
      return null;
    }
    return {
      hadClear: parsed.hadClear,
      next: parsed.next
    };
  } catch {
    return null;
  }
}

export function parseProviderKeyPayload(raw: string): ProviderKeyParsePayload | null {
  try {
    const parsed = JSON.parse(raw) as {
      providerId?: unknown;
      alias?: unknown;
      keyIndex?: unknown;
    };
    if (!parsed || typeof parsed !== 'object') {
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
  } catch {
    return null;
  }
}

export function parseAntigravitySessionIdPayload(raw: string): AntigravitySessionIdPayload | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'string') {
      return null;
    }
    const sessionId = parsed.trim();
    if (!sessionId) {
      return null;
    }
    return { sessionId };
  } catch {
    return null;
  }
}

export function parseAntigravityPinnedAliasLookupPayload(raw: string): AntigravityPinnedAliasLookupPayload | null {
  try {
    const parsed = JSON.parse(raw) as { alias?: unknown } | null;
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
  } catch {
    return null;
  }
}

export function parseAntigravityPinnedAliasUnpinPayload(raw: string): AntigravityPinnedAliasUnpinPayload | null {
  try {
    const parsed = JSON.parse(raw) as { changed?: unknown };
    if (!parsed || typeof parsed.changed !== 'boolean') {
      return null;
    }
    return { changed: parsed.changed };
  } catch {
    return null;
  }
}

export function parseAntigravityCacheSignaturePayload(raw: string): AntigravityCacheSignaturePayload | null {
  try {
    const parsed = JSON.parse(raw) as { ok?: unknown };
    if (!parsed || typeof parsed.ok !== 'boolean') {
      return null;
    }
    return { ok: parsed.ok };
  } catch {
    return null;
  }
}

export function parseAntigravityRequestSessionMetaPayload(raw: string): AntigravityRequestSessionMetaPayload | null {
  try {
    const parsed = JSON.parse(raw) as {
      aliasKey?: unknown;
      sessionId?: unknown;
      messageCount?: unknown;
    } | null;
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
  } catch {
    return null;
  }
}
