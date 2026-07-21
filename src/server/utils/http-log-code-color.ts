export const ANSI_HTTP_LOG_RESET = '\x1b[0m';
export const ANSI_HTTP_LOG_WHITE = '\x1b[97m';
export const ANSI_HTTP_LOG_RED = '\x1b[31m';

const IMPORTANT_LOG_KEYS = new Set([
  'catalogCode',
  'catalogKey',
  'code',
  'errorCode',
  'finish_reason',
  'httpStatus',
  'httpStatusCode',
  'internalCode',
  'model',
  'provider',
  'providerKey',
  'providerModel',
  'route',
  'routeName',
  'status',
  'statusCode',
  'target',
  'upstreamCode',
  'upstreamStatus'
]);

const STATUS_LOG_KEYS = new Set([
  'httpStatus',
  'httpStatusCode',
  'status',
  'statusCode',
  'upstreamStatus'
]);

const ERROR_CODE_LOG_KEYS = new Set([
  'catalogKey',
  'code',
  'errorCode',
  'internalCode',
  'upstreamCode'
]);

const LOG_KEY_VALUE_PATTERN = /(\x1b\[[0-9;]*m)?([A-Za-z][A-Za-z0-9_.]*)=([^ \x1b,)\]]+)([,\)])?/g;
const STANDALONE_HTTP_CODE_PATTERN = /(\x1b\[[0-9;]*m)?(?<!=)\bHTTP_[1-5]\d{2}(?:_[A-Za-z0-9]+)*\b/gi;
const VIRTUAL_ROUTER_HIT_TARGET_PATTERN = /(\x1b\[[0-9;]*m)?\b([A-Za-z][A-Za-z0-9_.:-]*\/[A-Za-z0-9_.:-]+)\s+->\s+([^ \x1b]+)(?=\s|$)/g;

function normalizeLogValue(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '');
}

function parseHttpStatusLikeValue(value: string): number | undefined {
  const normalized = normalizeLogValue(value);
  const httpCodeMatch = /^HTTP_([1-5]\d{2})(?:\b|_)/i.exec(normalized);
  if (httpCodeMatch?.[1]) {
    return Number(httpCodeMatch[1]);
  }
  const numericMatch = /^([1-5]\d{2})(?:\.\d+)?$/.exec(normalized);
  if (numericMatch?.[1]) {
    return Number(numericMatch[1]);
  }
  return undefined;
}

function isErrorHttpStatus(value: string): boolean {
  const status = parseHttpStatusLikeValue(value);
  return typeof status === 'number' && status >= 400;
}

function isErrorLogKeyValue(key: string, value: string): boolean {
  if (STATUS_LOG_KEYS.has(key) || key === 'catalogCode') {
    return isErrorHttpStatus(value);
  }
  if (ERROR_CODE_LOG_KEYS.has(key)) {
    const status = parseHttpStatusLikeValue(value);
    if (typeof status === 'number') {
      return status >= 400;
    }
    return key === 'catalogKey' || key === 'code' || key === 'errorCode' || key === 'internalCode';
  }
  return /^HTTP_[45]\d{2}(?:\b|_)/i.test(normalizeLogValue(value));
}

function isImportantLogKeyValue(key: string, value: string): boolean {
  if (IMPORTANT_LOG_KEYS.has(key)) {
    return true;
  }
  return /^HTTP_[1-5]\d{2}(?:\b|_)/i.test(value);
}

export function colorizeImportantLogKeyValue(
  key: string,
  value: string,
  suffix: string,
  baseColor: string
): string | undefined {
  if (!isImportantLogKeyValue(key, value)) {
    return undefined;
  }
  const color = isErrorLogKeyValue(key, value) ? ANSI_HTTP_LOG_RED : ANSI_HTTP_LOG_WHITE;
  return `${color}${key}=${value}${ANSI_HTTP_LOG_RESET}${baseColor}${suffix}`;
}

export function highlightStandaloneHttpCodeTokens(text: string, baseColor: string): string {
  return text.replace(STANDALONE_HTTP_CODE_PATTERN, (match: string, ansiPrefix: string | undefined) => {
    if (ansiPrefix) {
      return match;
    }
    const color = isErrorHttpStatus(match) ? ANSI_HTTP_LOG_RED : ANSI_HTTP_LOG_WHITE;
    return `${color}${match}${ANSI_HTTP_LOG_RESET}${baseColor}`;
  });
}

function highlightVirtualRouterHitTarget(text: string, baseColor: string): string {
  if (!text.includes('[virtual-router-hit]')) {
    return text;
  }
  return text.replace(
    VIRTUAL_ROUTER_HIT_TARGET_PATTERN,
    (match: string, ansiPrefix: string | undefined, routePool: string, target: string) => {
      if (ansiPrefix) {
        return match;
      }
      return `${ANSI_HTTP_LOG_WHITE}${routePool}${ANSI_HTTP_LOG_RESET}${baseColor} -> ${ANSI_HTTP_LOG_WHITE}${target}${ANSI_HTTP_LOG_RESET}${baseColor}`;
    }
  );
}

export function highlightImportantLogFields(text: string, baseColor = ''): string {
  if (!text) {
    return text;
  }
  const highlightedKeyValues = text.replace(
    LOG_KEY_VALUE_PATTERN,
    (match: string, ansiPrefix: string | undefined, key: string, value: string, suffix = '') => {
      if (ansiPrefix) {
        return match;
      }
      return colorizeImportantLogKeyValue(key, value, suffix, baseColor) ?? match;
    }
  );
  return highlightVirtualRouterHitTarget(
    highlightStandaloneHttpCodeTokens(highlightedKeyValues, baseColor),
    baseColor
  );
}

export const highlightHttpCodesInLogText = highlightImportantLogFields;
