import {
  parseChatProcessMediaAnalysisPayload,
  parseChatProcessMediaStripPayload,
  parseChatWebSearchIntentPayload,
  parseContinueExecutionInjectionPayload,
  parsePendingToolSyncPayload,
  parseProviderKeyPayload,
  parseDecideHeavyInputFastpathPayload
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


export function sanitizeChatProcessMessagesWithNative(request: Record<string, unknown>): {
    messages: Record<string, unknown>[];
    removedAssistantTurns: number;
    removedEmptyAssistantTurns: number;
    removedTemplateAssistantTurns: number;
    removedDuplicateMirrorAssistantTurns: number;
    removedHistoricalGoalTurns: number;
    didMutateMessageShapes: boolean;
} {
    const capability = 'sanitizeChatProcessMessagesJson';
    const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown>;
    const fn = binding?.[capability] as ((input: string) => string) | undefined;
    if (typeof fn !== 'function') {
        throw makeNativeRequiredError(capability);
    }
    const raw = fn(JSON.stringify(request));
    return JSON.parse(raw) as {
        messages: Record<string, unknown>[];
        removedAssistantTurns: number;
        removedEmptyAssistantTurns: number;
        removedTemplateAssistantTurns: number;
        removedDuplicateMirrorAssistantTurns: number;
        removedHistoricalGoalTurns: number;
        didMutateMessageShapes: boolean;
    };
}

export function loadNativeRouterHotpathBindingForInternalUse(): unknown {
  return loadNativeRouterHotpathBinding();
}


export function decideHeavyInputFastpath(
  request: Record<string, unknown>,
  metadata: Record<string, unknown>
): { estimatedTokens: number; shouldMark: boolean; reason?: string; source: 'native' } {
  const parsed = callNativeJson(
    'decideHeavyInputFastpathJson',
    'decideHeavyInputFastpathJson',
    [JSON.stringify({ request, metadata })],
    parseDecideHeavyInputFastpathPayload
  );
  return { ...parsed, source: 'native' };
}
