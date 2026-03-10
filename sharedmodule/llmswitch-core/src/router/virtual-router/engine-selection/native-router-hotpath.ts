import {
  parseAntigravityPinnedAliasLookupPayload,
  parseAntigravityPinnedAliasUnpinPayload,
  parseAntigravityCacheSignaturePayload,
  parseAntigravityRequestSessionMetaPayload,
  parseAntigravitySessionIdPayload,
  parseClockClearDirectivePayload,
  parseChatProcessMediaAnalysisPayload,
  parseChatProcessMediaStripPayload,
  parseChatWebSearchIntentPayload,
  parseContinueExecutionInjectionPayload,
  parsePendingToolSyncPayload,
  parseProviderKeyPayload
} from './native-router-hotpath-analysis.js';
import {
  isNativeDisabledByEnv,
  makeNativeRequiredError
} from './native-router-hotpath-policy.js';
import {
  loadNativeRouterHotpathBinding
} from './native-router-hotpath-loader.js';
export {
  buildQuotaBuckets,
  buildQuotaBucketsWithMode,
  getNativeRouterHotpathSource,
  resolveNativeModuleUrlFromEnv,
  type QuotaBucketInputEntry,
  type QuotaBucketResult
} from './native-router-hotpath-quota-buckets.js';

type AntigravitySplitPayload = {
  nonAntigravity: string[];
  hasAntigravity: boolean;
};

function parseAntigravitySplitPayload(raw: string): AntigravitySplitPayload | null {
  try {
    const parsed = JSON.parse(raw) as AntigravitySplitPayload;
    if (!parsed || !Array.isArray(parsed.nonAntigravity) || typeof parsed.hasAntigravity !== 'boolean') {
      return null;
    }
    const nonAntigravity = parsed.nonAntigravity.filter((value): value is string => typeof value === 'string');
    return {
      nonAntigravity,
      hasAntigravity: parsed.hasAntigravity
    };
  } catch {
    return null;
  }
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

function callNativeJson<T>(
  capability: string,
  exportName: string,
  args: string[],
  parse: (raw: string) => T | null
): T {
  const fn = requireNativeFunction(capability, exportName);
  let raw: unknown;
  try {
    raw = fn(...args);
  } catch (error) {
    throw makeNativeRequiredError(capability, toErrorReason(error));
  }
  if (typeof raw !== 'string' || !raw) {
    throw makeNativeRequiredError(capability, 'empty result');
  }
  const parsed = parse(raw);
  if (!parsed) {
    throw makeNativeRequiredError(capability, 'invalid payload');
  }
  return parsed;
}

export function splitAntigravityTargets(
  targets: string[]
): { nonAntigravity: string[]; hasAntigravity: boolean; source: 'native' } {
  const parsed = callNativeJson(
    'splitAntigravityTargetsJson',
    'splitAntigravityTargetsJson',
    [JSON.stringify(targets)],
    parseAntigravitySplitPayload
  );
  return { ...parsed, source: 'native' };
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

export function stripClockClearDirectiveText(
  text: string
): { hadClear: boolean; next: string; source: 'native' } {
  const parsed = callNativeJson(
    'stripClockClearDirectiveTextJson',
    'stripClockClearDirectiveTextJson',
    [String(text || '')],
    parseClockClearDirectivePayload
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

export function analyzeProviderKey(providerKey: string): {
  providerId: string | null; alias: string | null; keyIndex?: number; source: 'native'
} {
  const parsed = callNativeJson(
    'parseProviderKeyJson',
    'parseProviderKeyJson',
    [String(providerKey || '')],
    parseProviderKeyPayload
  );
  return { ...parsed, source: 'native' };
}

export function extractAntigravityGeminiSessionIdWithNative(payload: unknown): string {
  const parsed = callNativeJson(
    'extractAntigravityGeminiSessionIdJson',
    'extractAntigravityGeminiSessionIdJson',
    [JSON.stringify(payload ?? null)],
    parseAntigravitySessionIdPayload
  );
  return parsed.sessionId;
}

export function lookupAntigravityPinnedAliasForSessionIdWithNative(
  sessionId: string,
  options?: { hydrate?: boolean }
): string | undefined {
  const parsed = callNativeJson(
    'lookupAntigravityPinnedAliasForSessionIdJson',
    'lookupAntigravityPinnedAliasForSessionIdJson',
    [JSON.stringify({ sessionId: String(sessionId || ''), hydrate: options?.hydrate !== false })],
    parseAntigravityPinnedAliasLookupPayload
  );
  return parsed.alias;
}

export function unpinAntigravitySessionAliasForSessionIdWithNative(sessionId: string): boolean {
  const parsed = callNativeJson(
    'unpinAntigravitySessionAliasForSessionIdJson',
    'unpinAntigravitySessionAliasForSessionIdJson',
    [JSON.stringify({ sessionId: String(sessionId || '') })],
    parseAntigravityPinnedAliasUnpinPayload
  );
  return parsed.changed;
}

export function cacheAntigravitySessionSignatureWithNative(input: {
  aliasKey: string;
  sessionId: string;
  signature: string;
  messageCount?: number;
}): boolean {
  const parsed = callNativeJson(
    'cacheAntigravitySessionSignatureJson',
    'cacheAntigravitySessionSignatureJson',
    [JSON.stringify({
      aliasKey: String(input.aliasKey || ''),
      sessionId: String(input.sessionId || ''),
      signature: String(input.signature || ''),
      messageCount: typeof input.messageCount === 'number' ? Math.floor(input.messageCount) : undefined
    })],
    parseAntigravityCacheSignaturePayload
  );
  return parsed.ok;
}

export function getAntigravityRequestSessionMetaWithNative(requestId: string): {
  aliasKey?: string;
  sessionId?: string;
  messageCount?: number;
} {
  return callNativeJson(
    'getAntigravityRequestSessionMetaJson',
    'getAntigravityRequestSessionMetaJson',
    [JSON.stringify({ requestId: String(requestId || '') })],
    parseAntigravityRequestSessionMetaPayload
  );
}

export function resetAntigravitySignatureCachesWithNative(): boolean {
  const parsed = callNativeJson(
    'resetAntigravitySignatureCachesJson',
    'resetAntigravitySignatureCachesJson',
    ['{}'],
    parseAntigravityCacheSignaturePayload
  );
  return parsed.ok;
}

export function loadNativeRouterHotpathBindingForInternalUse(): unknown {
  return loadNativeRouterHotpathBinding();
}
