import { normalizeAssistantTextToToolCallsWithNative } from '../../../native/router-hotpath/native-shared-conversion-semantics.js';

type JsonToolArgumentAliasMap = Record<string, string[]>;

export type JsonToolRepairConfig = {
  toolNameAliases?: Record<string, string>;
  argumentAliases?: Record<string, JsonToolArgumentAliasMap>;
};

export type TextMarkupNormalizeOptions = {
  jsonToolRepair?: JsonToolRepairConfig;
};

export type ToolCallLite = { id?: string; name: string; args: string };

function enabled(): boolean {
  try {
    return String((process as any)?.env?.RCC_TEXT_MARKUP_COMPAT ?? '1').trim() !== '0';
  } catch {
    return true;
  }
}

export function normalizeAssistantTextToToolCalls(
  message: Record<string, any>,
  options?: TextMarkupNormalizeOptions
): Record<string, any> {
  if (!enabled()) return message;
  const normalized = normalizeAssistantTextToToolCallsWithNative(message, options) as Record<string, any>;
  return normalized;
}
