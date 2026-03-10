import { isStopMessageFileReference, resolveStopMessageText } from './stop-message-file-resolver.js';
import { parseStopMessageInstructionWithNative } from './engine-selection/native-virtual-router-stop-message-semantics.js';
import type { RoutingInstruction } from './routing-instructions.js';

export const DEFAULT_STOP_MESSAGE_MAX_REPEATS = 10;

export function parseStopMessageInstruction(
  instruction: string
): RoutingInstruction | null {
  const resolved = parseStopMessageInstructionWithNative(instruction);
  if (!resolved) {
    return null;
  }
  if (resolved.kind === 'clear') {
    return { type: 'stopMessageClear' };
  }
  return {
    type: 'stopMessageSet',
    stopMessageText: resolveStopMessageText(resolved.text),
    stopMessageMaxRepeats: resolved.maxRepeats,
    stopMessageSource: isStopMessageFileReference(resolved.text) ? 'explicit_file' : 'explicit_text',
    ...(resolved.aiMode ? { stopMessageAiMode: resolved.aiMode } : {})
  };
}
