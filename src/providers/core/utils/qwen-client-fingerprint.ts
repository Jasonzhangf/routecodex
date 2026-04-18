/**
 * Align with the currently installed official Qwen Code CLI package:
 * - qwen CLI version: 0.14.3
 * - bundled openai SDK version used for Stainless headers: 5.11.0
 *
 * Keep runtime version dynamic (`process.version`) so the emitted header shape
 * matches the actual Node runtime that is serving requests.
 */
export const DEFAULT_QWEN_CODE_UA_VERSION = '0.14.3';
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

export function resolveQwenStainlessRuntimeVersion(): string {
  return typeof process.version === 'string' && process.version.trim()
    ? process.version.trim()
    : 'unknown';
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
    'X-Stainless-Runtime-Version': resolveQwenStainlessRuntimeVersion(),
    'X-Stainless-Lang': 'js',
    'X-Stainless-Arch': process.arch,
    'X-Stainless-Package-Version': QWEN_STAINLESS_PACKAGE_VERSION,
    'X-Stainless-Retry-Count': '0',
    'X-Stainless-OS': resolveQwenStainlessOs(),
    'X-Stainless-Runtime': 'node'
  };
}
