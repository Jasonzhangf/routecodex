export const ANSI_HTTP_LOG_RESET = '\x1b[0m';
export const ANSI_HTTP_LOG_ERROR = '\x1b[31m';
export const ANSI_HTTP_LOG_WHITE = '\x1b[97m';

const HTTP_STATUS_KEYS = new Set([
  'httpStatus',
  'httpStatusCode',
  'status',
  'statusCode',
  'upstreamStatus'
]);

const LOG_KEY_VALUE_PATTERN = /(\x1b\[[0-9;]*m)?([A-Za-z][A-Za-z0-9_.]*)=([^ \x1b,)\]]+)([,\)])?/g;
const STANDALONE_HTTP_CODE_PATTERN = /(\x1b\[[0-9;]*m)?(?<!=)\bHTTP_([1-5]\d{2})(?:_[A-Za-z0-9]+)*\b/gi;

function colorForStatus(status: number): string | undefined {
  if (!Number.isFinite(status) || status < 100 || status > 599) {
    return undefined;
  }
  return status >= 400 ? ANSI_HTTP_LOG_ERROR : ANSI_HTTP_LOG_WHITE;
}

function resolveHttpStatusFromLogValue(key: string, value: string): number | undefined {
  const httpCode = /^HTTP_([1-5]\d{2})(?:\b|_)/i.exec(value);
  if (httpCode) {
    return Number.parseInt(httpCode[1], 10);
  }
  if (!HTTP_STATUS_KEYS.has(key) || !/^[1-5]\d{2}$/.test(value)) {
    return undefined;
  }
  return Number.parseInt(value, 10);
}

export function colorizeHttpLogKeyValue(
  key: string,
  value: string,
  suffix: string,
  baseColor: string
): string | undefined {
  const status = resolveHttpStatusFromLogValue(key, value);
  const color = typeof status === 'number' ? colorForStatus(status) : undefined;
  if (!color) {
    return undefined;
  }
  return `${color}${key}=${value}${ANSI_HTTP_LOG_RESET}${baseColor}${suffix}`;
}

export function highlightStandaloneHttpCodeTokens(text: string, baseColor: string): string {
  return text.replace(STANDALONE_HTTP_CODE_PATTERN, (match: string, ansiPrefix: string | undefined, statusText: string) => {
    if (ansiPrefix) {
      return match;
    }
    const color = colorForStatus(Number.parseInt(statusText, 10));
    return color ? `${color}${match}${ANSI_HTTP_LOG_RESET}${baseColor}` : match;
  });
}

export function highlightHttpCodesInLogText(text: string, baseColor = ''): string {
  if (!text) {
    return text;
  }
  const highlightedKeyValues = text.replace(
    LOG_KEY_VALUE_PATTERN,
    (match: string, ansiPrefix: string | undefined, key: string, value: string, suffix = '') => {
      if (ansiPrefix) {
        return match;
      }
      return colorizeHttpLogKeyValue(key, value, suffix, baseColor) ?? match;
    }
  );
  return highlightStandaloneHttpCodeTokens(highlightedKeyValues, baseColor);
}
