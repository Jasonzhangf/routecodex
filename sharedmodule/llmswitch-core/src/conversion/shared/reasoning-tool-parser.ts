import { extractToolCallsFromReasoningTextWithNative } from '../../native/router-hotpath/native-shared-conversion-semantics.js';

type ToolCallRecord = Record<string, unknown>;

interface ExtractionOptions {
  idPrefix?: string;
}

interface ExtractionResult {
  cleanedText: string;
  toolCalls: ToolCallRecord[];
}

function assertReasoningToolParserNativeAvailable(): void {
  if (typeof extractToolCallsFromReasoningTextWithNative !== 'function') {
    throw new Error('[reasoning-tool-parser] native bindings unavailable');
  }
}

export function extractToolCallsFromReasoningText(text: string, options?: ExtractionOptions): ExtractionResult {
  assertReasoningToolParserNativeAvailable();
  const idPrefix = options?.idPrefix ?? 'reasoning';
  return extractToolCallsFromReasoningTextWithNative(String(text ?? ''), idPrefix);
}
