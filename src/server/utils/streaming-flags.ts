const truthy = new Set(['1', 'true', 'yes', 'on']);
const falsy = new Set(['0', 'false', 'no', 'off']);

function parseFlag(value: unknown): boolean | undefined {
  if (value == null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (truthy.has(normalized)) return true;
  if (falsy.has(normalized)) return false;
  return undefined;
}

const GLOBAL_KEYS = ['ROUTECODEX_DISABLE_SYNTHETIC_SSE', 'RCC_DISABLE_SYNTHETIC_SSE'];

const ENTRY_KEYS: Record<string, string[]> = {
  '/v1/chat/completions': ['ROUTECODEX_DISABLE_CHAT_SSE', 'RCC_DISABLE_CHAT_SSE'],
  '/v1/responses': ['ROUTECODEX_DISABLE_RESPONSES_SSE', 'RCC_DISABLE_RESPONSES_SSE'],
  '/v1/messages': ['ROUTECODEX_DISABLE_MESSAGES_SSE', 'ROUTECODEX_DISABLE_ANTHROPIC_SSE', 'RCC_DISABLE_MESSAGES_SSE', 'RCC_DISABLE_ANTHROPIC_SSE']
};

function resolve(keys: string[]): boolean | undefined {
  for (const key of keys) {
    const flag = parseFlag(process.env[key]);
    if (flag !== undefined) return flag;
  }
  return undefined;
}

export function isEntryStreamingAllowed(entryEndpoint: string): boolean {
  const globalFlag = resolve(GLOBAL_KEYS);
  if (globalFlag === true) return false;
  if (globalFlag === false) return true;

  const endpoint = entryEndpoint?.toLowerCase();
  const keys = ENTRY_KEYS[endpoint];
  if (!keys) return true;
  const flag = resolve(keys);
  if (flag === undefined) return true;
  return flag === false;
}

