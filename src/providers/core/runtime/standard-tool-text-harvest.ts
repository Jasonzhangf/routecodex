import { processChatResponseTools } from '../../../../sharedmodule/llmswitch-core/dist/conversion/shared/tool-governor.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Provider-agnostic text-tool response harvest entry.
 *
 * - Harvests text-emitted tool calls (e.g. <function_calls>...</function_calls>)
 *   into standard OpenAI chat tool_calls payload.
 * - Keep this wrapper neutral so providers share one skeleton.
 */
export function applyStandardToolTextHarvestToChatPayload<T extends Record<string, unknown>>(payload: T): T {
  const harvested = processChatResponseTools(payload as any);
  return (isRecord(harvested) ? harvested : payload) as T;
}
