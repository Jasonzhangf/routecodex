import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

function toNapiExportName(name: string): string {
  return name.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
}

export function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name] ?? binding?.[toNapiExportName(name)];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

export function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export function parseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function parseRecord(raw: string): Record<string, unknown> | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

export function parseArray(raw: string): Array<unknown> | null {
  const parsed = parseJson(raw);
  return Array.isArray(parsed) ? parsed : null;
}

export function parseString(raw: string): string | null {
  const parsed = parseJson(raw);
  return typeof parsed === 'string' ? parsed : null;
}

export function callNativeString(capability: string, input: Record<string, unknown>): string {
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error(`[virtual-router-native-hotpath] native ${capability} is required but unavailable`);
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    throw new Error(`[virtual-router-native-hotpath] native ${capability} is required but unavailable: json stringify failed`);
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      throw new Error('empty result');
    }
    const parsed = parseString(raw);
    if (typeof parsed !== 'string' || !parsed) {
      throw new Error('invalid payload');
    }
    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`[virtual-router-native-hotpath] native ${capability} is required but unavailable: ${reason}`);
  }
}

export function resolveRccUserDirWithNative(homeDir?: string): string {
  return callNativeString('resolveRccUserDirJson', {
    homeDir,
    rccHome: process.env.RCC_HOME,
    routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
    routecodexHome: process.env.ROUTECODEX_HOME
  });
}

export function resolveRccPathWithNative(...segments: string[]): string {
  return callNativeString('resolveRccPathJson', { segments });
}

export function parseStringArray(raw: string): string[] | null {
  const parsed = parseArray(raw);
  if (!parsed) {
    return null;
  }
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') {
      return null;
    }
    out.push(item);
  }
  return out;
}
