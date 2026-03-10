import type { StandardizedTool } from '../types/standardized.js';
import { castGovernedToolsWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';

export function castGovernedTools(tools: unknown): StandardizedTool[] | undefined {
  return castGovernedToolsWithNative(tools) as StandardizedTool[] | undefined;
}
