import {
  parseChatProcessMediaAnalysisPayload,
  parseChatProcessMediaStripPayload,
  parseChatWebSearchIntentPayload,
  parseContinueExecutionInjectionPayload,
  parsePendingToolSyncPayload
} from './native-router-hotpath-analysis.js';
import {
  isNativeDisabledByEnv,
  makeNativeRequiredError
} from './native-router-hotpath-loader.js';
import {
  loadNativeRouterHotpathBinding,
  parseVirtualRouterNativeError
} from './native-router-hotpath-loader.js';

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
