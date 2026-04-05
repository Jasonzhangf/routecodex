import { importCoreDist } from '../../../modules/llmswitch/bridge/module-loader.js';

type ToolGovernorModule = {
  processChatResponseTools?: (payload: Record<string, unknown>) => Record<string, unknown>;
};

const toolGovernorModule = await importCoreDist<ToolGovernorModule>('conversion/shared/tool-governor');
const processChatResponseToolsFn: NonNullable<ToolGovernorModule['processChatResponseTools']> = (() => {
  const fn = toolGovernorModule?.processChatResponseTools;
  if (typeof fn !== 'function') {
    throw new Error('[standard-tool-text-harvest] processChatResponseTools not available');
  }
  return fn;
})();

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
  const harvested = processChatResponseToolsFn(payload as any);
  return (isRecord(harvested) ? harvested : payload) as T;
}
