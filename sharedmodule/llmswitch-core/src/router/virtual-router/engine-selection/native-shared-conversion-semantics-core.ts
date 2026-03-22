import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
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
