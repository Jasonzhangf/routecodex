import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-loader.js';

export { isNativeDisabledByEnv };

const NON_BLOCKING_PARSE_LOG_THROTTLE_MS = 60_000;
const nonBlockingParseLogState = new Map<string, number>();

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

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  return safeStringify(error) ?? String(error);
}

export function failNative<T>(capability: string, reason?: string): T {
  return failNativeRequired<T>(capability, reason);
}

export function extractNativeErrorMessage(raw: unknown): string {
  if (raw instanceof Error) {
    return raw.message;
  }
  if (raw && typeof raw === 'object' && 'message' in (raw as Record<string, unknown>)) {
    const candidate = (raw as Record<string, unknown>).message;
    return typeof candidate === 'string' ? candidate : '';
  }
  return '';
}

export function stringifyNativePayloadForError(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length ? trimmed : undefined;
  }
  if (raw instanceof Error) {
    const message = typeof raw.message === 'string' ? raw.message.trim() : '';
    if (message.length) {
      return message;
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const row = raw as Record<string, unknown>;
    const message = typeof row.message === 'string' ? row.message.trim() : '';
    if (message.length) {
      return message;
    }
    const code = typeof row.code === 'string' ? row.code.trim() : '';
    if (code.length) {
      return code;
    }
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

export function readNativeJsonResult(capability: string, raw: unknown): string {
  if (typeof raw === 'string') {
    if (!raw) {
      return failNativeRequired<string>(capability, 'empty result');
    }
    return raw;
  }
  const reason = stringifyNativePayloadForError(raw);
  if (reason) {
    throw new Error(reason);
  }
  return failNativeRequired<string>(capability, 'empty result');
}

export function shouldRethrowNativeRawError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  return !error.message.startsWith('[virtual-router-native-hotpath] native ');
}

function logNativeJsonParserNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingParseLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_PARSE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingParseLogState.set(stage, now);
  const reason = stringifyNativePayloadForError(error) ?? 'unknown';
  console.warn(`[native-shared-conversion-semantics-core] ${stage} parse failed (non-blocking): ${reason}`);
}

export function parseNativeJsonValueOrFail<T>(capability: string, raw: string, stage = capability): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    logNativeJsonParserNonBlocking(stage, error);
    return failNativeRequired<T>(capability, 'invalid payload');
  }
}

export function parseNativeJsonObjectOrFail<T extends Record<string, unknown>>(
  capability: string,
  raw: string,
  stage = capability
): T {
  const parsed = parseNativeJsonValueOrFail<unknown>(capability, raw, stage);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failNativeRequired<T>(capability, 'invalid payload');
  }
  return parsed as T;
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
