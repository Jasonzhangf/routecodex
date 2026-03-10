import { castGovernedTools } from './chat-process-tool-normalization.js';
import type { StandardizedRequest } from '../types/standardized.js';
import { applyGovernedMergeRequestWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';

interface GovernedMergeOptions {
  request: StandardizedRequest;
  governed: Record<string, unknown>;
  inboundStreamIntent: boolean;
}

export function buildGovernedMergedRequest(options: GovernedMergeOptions): StandardizedRequest {
  const { request, governed, inboundStreamIntent } = options;
  const governanceTimestamp = Date.now();
  const mergedBase = applyGovernedMergeRequestWithNative(
    request as unknown as Record<string, unknown>,
    governed,
    inboundStreamIntent,
    governanceTimestamp
  ) as unknown as StandardizedRequest;

  return {
    ...mergedBase,
    tools:
      governed.tools !== undefined ? castGovernedTools(governed.tools) : request.tools
  };
}
