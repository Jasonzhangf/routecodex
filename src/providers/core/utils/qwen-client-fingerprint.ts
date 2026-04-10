export const DEFAULT_QWEN_CODE_UA_VERSION = '0.13.2';
export const QWEN_STAINLESS_RUNTIME_VERSION = 'v22.17.0';
export const QWEN_STAINLESS_PACKAGE_VERSION = '5.11.0';

export function resolveQwenCodeUserAgentVersion(): string {
  const fromEnv =
    process.env.ROUTECODEX_QWEN_UA_VERSION ||
    process.env.RCC_QWEN_UA_VERSION ||
    process.env.ROUTECODEX_QWEN_CODE_UA_VERSION ||
    process.env.RCC_QWEN_CODE_UA_VERSION;
  const normalized = typeof fromEnv === 'string' ? fromEnv.trim() : '';
  return normalized || DEFAULT_QWEN_CODE_UA_VERSION;
}

export function resolveQwenCodeUserAgent(): string {
  return `QwenCode/${resolveQwenCodeUserAgentVersion()} (${process.platform}; ${process.arch})`;
}

export function resolveQwenStainlessOs(): string {
  if (process.platform === 'darwin') {
    return 'MacOS';
  }
  if (process.platform === 'win32') {
    return 'Windows';
  }
  return 'Linux';
}

export function buildQwenStainlessHeaderEntries(): Record<string, string> {
  return {
    'X-Stainless-Runtime-Version': QWEN_STAINLESS_RUNTIME_VERSION,
    'X-Stainless-Lang': 'js',
    'X-Stainless-Arch': process.arch,
    'X-Stainless-Package-Version': QWEN_STAINLESS_PACKAGE_VERSION,
    'X-Stainless-Retry-Count': '0',
    'X-Stainless-Os': resolveQwenStainlessOs(),
    'X-Stainless-Runtime': 'node'
  };
}
