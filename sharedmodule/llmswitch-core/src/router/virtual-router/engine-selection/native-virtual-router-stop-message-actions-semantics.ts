import { failNativeRequired } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

const STOP_MESSAGE_FIELDS = new Set([
  'stopMessageSource',
  'stopMessageText',
  'stopMessageMaxRepeats',
  'stopMessageUsed',
  'stopMessageUpdatedAt',
  'stopMessageLastUsedAt',
  'stopMessageStageMode',
  'stopMessageAiMode',
  'stopMessageAiSeedPrompt',
  'stopMessageAiHistory'
]);

export type NativeStopMessageActionPatch = {
  applied: boolean;
  set: Record<string, unknown>;
  unset: string[];
};

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function parseActionPatchPayload(raw: string): NativeStopMessageActionPatch | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (typeof row.applied !== 'boolean') {
      return null;
    }
    const setRaw = row.set;
    const unsetRaw = row.unset;

    const normalizedSet: Record<string, unknown> = {};
    if (setRaw && typeof setRaw === 'object' && !Array.isArray(setRaw)) {
      for (const [key, value] of Object.entries(setRaw as Record<string, unknown>)) {
        if (value !== undefined) {
          normalizedSet[key] = value;
        }
      }
    }

    const normalizedUnset = Array.isArray(unsetRaw)
      ? unsetRaw.filter((key): key is string => typeof key === 'string')
      : [];

    return {
      applied: row.applied,
      set: normalizedSet,
      unset: Array.from(new Set(normalizedUnset))
    };
  } catch {
    return null;
  }
}

export function applyStopMessageInstructionWithNative(
  instruction: unknown,
  state: unknown,
  nowMs: number
): NativeStopMessageActionPatch {
  const capability = 'applyStopMessageInstructionJson';
  const fail = (reason?: string) => failNativeRequired<NativeStopMessageActionPatch>(capability, reason);
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }

  const instructionJson = safeStringify(instruction);
  const stateJson = safeStringify(state);
  if (!instructionJson || !stateJson) {
    return fail('json stringify failed');
  }

  try {
    const result = fn(instructionJson, stateJson, Math.floor(nowMs));
    if (typeof result !== 'string' || !result) {
      return fail('empty result');
    }
    const parsed = parseActionPatchPayload(result);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
