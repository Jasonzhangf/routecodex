import { stripResponsesStoredContextInputMediaNative } from '../../../modules/llmswitch/bridge/native-exports.js';

export function stripDirectTargetUnsupportedMedia(
  inputEntries: unknown,
  placeholderText = '[Image omitted]'
): { changed: boolean; messages: unknown[] } {
  return stripResponsesStoredContextInputMediaNative(inputEntries, placeholderText);
}
