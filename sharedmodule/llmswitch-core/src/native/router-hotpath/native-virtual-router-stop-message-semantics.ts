import {
  failNativeRequired
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import { resolveRccUserDir } from '../../runtime/user-data-paths.js';

export type StopMessageResolvedNativeParseOutput =
  | {
      type: 'stopMessageClear';
    }
  | {
      type: 'stopMessageMode';
      stopMessageStageMode: 'on' | 'off' | 'auto';
      stopMessageMaxRepeats?: number;
      stopMessageAiMode?: 'on' | 'off';
    }
  | {
      type: 'stopMessageSet';
      stopMessageText: string;
      stopMessageMaxRepeats?: number;
      stopMessageSource?: 'explicit_file' | 'explicit_text';
      stopMessageAiMode?: 'on' | 'off';
    };

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function parseResolvedStopMessageNativePayload(raw: string): StopMessageResolvedNativeParseOutput | null {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.type === 'stopMessageClear') return { type: 'stopMessageClear' };
  if (
    parsed.type === 'stopMessageMode' &&
    (parsed.stopMessageStageMode === 'on' ||
      parsed.stopMessageStageMode === 'off' ||
      parsed.stopMessageStageMode === 'auto')
  ) {
    return {
      type: 'stopMessageMode',
      stopMessageStageMode: parsed.stopMessageStageMode,
      ...(typeof parsed.stopMessageMaxRepeats === 'number' ? { stopMessageMaxRepeats: parsed.stopMessageMaxRepeats } : {}),
      ...(parsed.stopMessageAiMode === 'on' || parsed.stopMessageAiMode === 'off' ? { stopMessageAiMode: parsed.stopMessageAiMode } : {})
    };
  }
  if (parsed.type !== 'stopMessageSet' || typeof parsed.stopMessageText !== 'string') return null;
  return {
    type: 'stopMessageSet',
    stopMessageText: parsed.stopMessageText,
    ...(typeof parsed.stopMessageMaxRepeats === 'number' ? { stopMessageMaxRepeats: parsed.stopMessageMaxRepeats } : {}),
    ...(parsed.stopMessageSource === 'explicit_file' || parsed.stopMessageSource === 'explicit_text'
      ? { stopMessageSource: parsed.stopMessageSource }
      : {}),
    ...(parsed.stopMessageAiMode === 'on' || parsed.stopMessageAiMode === 'off' ? { stopMessageAiMode: parsed.stopMessageAiMode } : {})
  };
}

export function parseResolvedStopMessageInstructionWithNative(
  instruction: string
): StopMessageResolvedNativeParseOutput | null {
  const capability = 'parseResolvedStopMessageInstructionJson';
  const fail = (reason?: string) => failNativeRequired<StopMessageResolvedNativeParseOutput | null>(capability, reason);
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const optionsJson = JSON.stringify({ rccUserDir: resolveRccUserDir() });
  try {
    const result = fn(String(instruction || ''), optionsJson);
    if (typeof result !== 'string') return fail('non-string result');
    if (!result || result === 'null') return null;
    return parseResolvedStopMessageNativePayload(result) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
