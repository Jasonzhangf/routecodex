import { failNativeRequired } from '../native/router-hotpath/native-router-hotpath-policy.js';
import {
  parseString,
  readNativeFunction,
  safeStringify,
} from '../native/router-hotpath/native-shared-conversion-semantics-core.js';

function callNativeString(capability: string, input: Record<string, unknown>): string {
  const fn = readNativeFunction(capability);
  if (!fn) {
    return failNativeRequired<string>(capability);
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return failNativeRequired<string>(capability, 'json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return failNativeRequired<string>(capability, 'empty result');
    }
    return parseString(raw) ?? failNativeRequired<string>(capability, 'invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<string>(capability, reason);
  }
}

export function resolveRccUserDir(homeDir?: string): string {
  return callNativeString('resolveRccUserDirJson', { homeDir });
}

export function resolveRccPath(...segments: string[]): string {
  return callNativeString('resolveRccPathJson', { segments });
}
