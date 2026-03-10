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

export function parseChatWebSearchIntentPayload(raw: string): ChatWebSearchIntentPayload | null {
  try {
    const parsed = JSON.parse(raw) as {
      hasIntent?: unknown;
      googlePreferred?: unknown;
    };
    if (
      !parsed ||
      typeof parsed.hasIntent !== 'boolean' ||
      typeof parsed.googlePreferred !== 'boolean'
    ) {
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
    const providerId = typeof parsed.providerId === 'string'
      ? parsed.providerId
      : parsed.providerId === null
        ? null
        : null;
    const alias = typeof parsed.alias === 'string'
      ? parsed.alias
      : parsed.alias === null
        ? null
        : null;
    const keyIndex = typeof parsed.keyIndex === 'number' && Number.isFinite(parsed.keyIndex)
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

/**
 * @deprecated Native hotpath is required; TS fallback implementation is retained for test baselines only.
 */
export function analyzeProviderKeyFallback(
  providerKey: string
): ProviderKeyParsePayload & { source: 'ts-fallback' } {
  const key = String(providerKey || '');
  const firstDot = key.indexOf('.');
  const providerId = firstDot > 0 ? key.substring(0, firstDot) : null;
  let alias: string | null = null;
  if (firstDot > 0) {
    const secondDot = key.indexOf('.', firstDot + 1);
    if (secondDot > firstDot + 1) {
      const rawAlias = key.substring(firstDot + 1, secondDot);
      alias = /^\d+-/.test(rawAlias) ? rawAlias.replace(/^\d+-/, '') : rawAlias;
    }
  }
  let keyIndex: number | undefined;
  const parts = key.split('.');
  if (parts.length === 2) {
    const idx = Number.parseInt(parts[1] ?? '', 10);
    if (Number.isFinite(idx) && idx > 0) {
      keyIndex = idx;
    }
  }
  return {
    providerId,
    alias,
    ...(keyIndex !== undefined ? { keyIndex } : {}),
    source: 'ts-fallback'
  };
}

/**
 * @deprecated Native hotpath is required; TS fallback implementation is retained for test baselines only.
 */
export function analyzePendingToolSyncFallback(
  messages: unknown[],
  afterToolCallIds: string[]
): { ready: boolean; insertAt: number; source: 'ts-fallback' } {
  const normalizedAfterIds = Array.isArray(afterToolCallIds)
    ? afterToolCallIds
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
    : [];
  if (!normalizedAfterIds.length) {
    return { ready: false, insertAt: -1, source: 'ts-fallback' };
  }

  const toolCallIds = new Set<string>();
  let insertAt = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const row = messages[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      continue;
    }
    const msg = row as Record<string, unknown>;
    if (msg.role !== 'tool') {
      continue;
    }
    insertAt = i;
    const rawToolCallId =
      typeof msg.tool_call_id === 'string'
        ? msg.tool_call_id
        : typeof msg.toolCallId === 'string'
          ? msg.toolCallId
          : '';
    const toolCallId = rawToolCallId.trim();
    if (toolCallId) {
      toolCallIds.add(toolCallId);
    }
  }

  const ready = normalizedAfterIds.every((id) => toolCallIds.has(id));
  return {
    ready,
    insertAt,
    source: 'ts-fallback'
  };
}

/**
 * @deprecated Native hotpath is required; TS fallback implementation is retained for test baselines only.
 */
export function analyzeContinueExecutionInjectionFallback(
  messages: unknown[],
  marker: string,
  targetText: string
): { hasDirective: boolean; source: 'ts-fallback' } {
  const normalizedMarker = typeof marker === 'string' ? marker.trim() : '';
  const normalizedTargetText = typeof targetText === 'string' ? targetText.trim() : '';
  if (!normalizedMarker && !normalizedTargetText) {
    return { hasDirective: false, source: 'ts-fallback' };
  }
  for (const row of messages) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      continue;
    }
    const msg = row as Record<string, unknown>;
    if (msg.role !== 'user') {
      continue;
    }
    const content = msg.content;
    if (
      messageContentContainsToken(content, normalizedMarker) ||
      messageContentContainsToken(content, normalizedTargetText)
    ) {
      return { hasDirective: true, source: 'ts-fallback' };
    }
  }
  return { hasDirective: false, source: 'ts-fallback' };
}

/**
 * @deprecated Native hotpath is required; TS fallback implementation is retained for test baselines only.
 */
export function stripClockClearDirectiveTextFallback(
  text: string
): ClockClearDirectivePayload & { source: 'ts-fallback' } {
  const pattern = /<\*\*\s*clock\s*:\s*clear\s*\*\*>/gi;
  const hadClear = pattern.test(text);
  if (!hadClear) {
    return { hadClear: false, next: text, source: 'ts-fallback' };
  }
  const replaced = text.replace(pattern, '');
  const next = replaced.replace(/\n{3,}/g, '\n\n').trim();
  return {
    hadClear: true,
    next,
    source: 'ts-fallback'
  };
}

/**
 * @deprecated Native hotpath is required; TS fallback implementation is retained for test baselines only.
 */
export function analyzeChatProcessMediaFallback(
  messages: unknown[]
): ChatProcessMediaAnalysisPayload & { source: 'ts-fallback' } {
  const rows = Array.isArray(messages) ? messages : [];
  if (!rows.length) {
    return { stripIndices: [], containsCurrentTurnImage: false, source: 'ts-fallback' };
  }

  const last = rows[rows.length - 1];
  const isNewUserTurn = readRole(last) === 'user';
  let latestUserIndex = -1;
  if (isNewUserTurn) {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (readRole(rows[i]) === 'user') {
        latestUserIndex = i;
        break;
      }
    }
    if (latestUserIndex < 0) {
      return { stripIndices: [], containsCurrentTurnImage: false, source: 'ts-fallback' };
    }
  }

  const stripIndices: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (isNewUserTurn && i === latestUserIndex) {
      continue;
    }
    if (readRole(rows[i]) !== 'user') {
      continue;
    }
    if (messageHasImagePart(rows[i])) {
      stripIndices.push(i);
    }
  }

  return {
    stripIndices,
    containsCurrentTurnImage: detectCurrentTurnImage(rows),
    source: 'ts-fallback'
  };
}

/**
 * @deprecated Native hotpath is required; TS fallback implementation is retained for test baselines only.
 */
export function analyzeChatWebSearchIntentFallback(
  messages: unknown[]
): ChatWebSearchIntentPayload & { source: 'ts-fallback' } {
  const content = extractLatestUserContent(messages);
  if (!content) {
    return { hasIntent: false, googlePreferred: false, source: 'ts-fallback' };
  }

  if (content.includes('谷歌搜索') || content.includes('谷歌一下') || content.includes('百度一下')) {
    return { hasIntent: true, googlePreferred: true, source: 'ts-fallback' };
  }

  const text = content.toLowerCase();
  const englishDirect = [
    'web search',
    'web_search',
    'websearch',
    'internet search',
    'search the web',
    'web-search',
    'internet-search',
    '/search'
  ];
  if (englishDirect.some((keyword) => text.includes(keyword))) {
    return { hasIntent: true, googlePreferred: text.includes('google'), source: 'ts-fallback' };
  }

  const verbTokensEn = ['search', 'find', 'look up', 'look for', 'google'];
  const nounTokensEn = ['web', 'internet', 'online', 'news', 'information', 'info', 'report', 'reports', 'article', 'articles'];
  if (verbTokensEn.some((token) => text.includes(token)) && nounTokensEn.some((token) => text.includes(token))) {
    return { hasIntent: true, googlePreferred: text.includes('google'), source: 'ts-fallback' };
  }

  if (content.includes('上网')) {
    return { hasIntent: true, googlePreferred: false, source: 'ts-fallback' };
  }

  const verbTokens = ['搜索', '查找', '搜'];
  const nounTokens = ['网络', '联网', '新闻', '信息', '报道'];
  if (verbTokens.some((token) => content.includes(token)) && nounTokens.some((token) => content.includes(token))) {
    return { hasIntent: true, googlePreferred: false, source: 'ts-fallback' };
  }

  return { hasIntent: false, googlePreferred: false, source: 'ts-fallback' };
}

function messageContentContainsToken(content: unknown, token: string): boolean {
  if (!token) {
    return false;
  }
  if (typeof content === 'string') {
    return content.includes(token);
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (part) =>
      part &&
      typeof part === 'object' &&
      typeof (part as { text?: unknown }).text === 'string' &&
      ((part as { text: string }).text).includes(token)
  );
}

function extractLatestUserContent(messages: unknown[]): string {
  const rows = Array.isArray(messages) ? messages : [];
  if (!rows.length) {
    return '';
  }
  const last = rows[rows.length - 1];
  if (readRole(last) !== 'user') {
    return '';
  }
  const content = (last as Record<string, unknown>).content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      texts.push(part);
      continue;
    }
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      continue;
    }
    const maybeText = (part as Record<string, unknown>).text;
    if (typeof maybeText === 'string' && maybeText.trim()) {
      texts.push(maybeText);
    }
  }
  return texts.join('\n');
}

function readRole(message: unknown): string {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return '';
  }
  const role = (message as Record<string, unknown>).role;
  return typeof role === 'string' ? role : '';
}

function messageHasImagePart(message: unknown): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content) || !content.length) {
    return false;
  }
  return content.some((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      return false;
    }
    const typeValue = (part as Record<string, unknown>).type;
    return typeof typeValue === 'string' && typeValue.toLowerCase().includes('image');
  });
}

function detectCurrentTurnImage(messages: unknown[]): boolean {
  const last = messages[messages.length - 1];
  if (readRole(last) !== 'user') {
    return false;
  }
  const content = (last as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return false;
  }
  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      continue;
    }
    const record = part as Record<string, unknown>;
    const typeValue = record.type;
    if (typeof typeValue !== 'string' || !typeValue.toLowerCase().includes('image')) {
      continue;
    }
    const imageCandidate = readImageCandidate(record);
    if (imageCandidate.trim().length > 0) {
      return true;
    }
  }
  return false;
}

function readImageCandidate(record: Record<string, unknown>): string {
  const imageUrl = record.image_url;
  if (typeof imageUrl === 'string') {
    return imageUrl;
  }
  if (imageUrl && typeof imageUrl === 'object' && !Array.isArray(imageUrl)) {
    const nestedUrl = (imageUrl as Record<string, unknown>).url;
    if (typeof nestedUrl === 'string') {
      return nestedUrl;
    }
  }
  if (typeof record.url === 'string') {
    return record.url;
  }
  if (typeof record.uri === 'string') {
    return record.uri;
  }
  if (typeof record.data === 'string') {
    return record.data;
  }
  return '';
}
