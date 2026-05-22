// Unified tool governance API (标准)
// Centralizes tool augmentation, guidance injection/refinement, and structured tool_calls canonicalization

// canonicalizer 按需加载（避免在请求侧仅注入时引入不必要的模块）

import {
  logToolGovernorNonBlocking,
  tryWriteSnapshot,
  type ToolGovernanceOptions,
  type Unknown
} from './tool-governor-shared.js';
import {
  normalizeApplyPatchToolCallsOnRequest,
    normalizeRequestToolCalls,
  processChatRequestTools
} from './tool-governor-request.js';
import {
  processChatResponseTools
} from './tool-governor-response.js';

export {
    normalizeApplyPatchToolCallsOnRequest,
    normalizeRequestToolCalls,
  processChatRequestTools,
  processChatResponseTools
};

export interface GovernContext extends ToolGovernanceOptions {
  phase: 'request' | 'response';
  endpoint?: 'chat' | 'responses' | 'messages';
  stream?: boolean;
  produceRequiredAction?: boolean; // default true for responses non-stream
  requestId?: string;
}

// Unified, 对齐 governance entry
export function governTools(payload: Unknown, ctx: GovernContext): Unknown {
  const phase = ctx?.phase || 'request';
  const ep = ctx?.endpoint || 'chat';
  if (phase === 'request') {
    return processChatRequestTools(payload, {
      injectGuidance: ctx?.injectGuidance !== false,
      snapshot: ctx?.snapshot || { enabled: true, endpoint: ep, requestId: ctx?.requestId }
    });
  }
  // response phase
  // 变更前快照：响应侧 canonicalize 之前
  try {
    const opts: ToolGovernanceOptions = { snapshot: ctx?.snapshot || { enabled: true, endpoint: ep, requestId: ctx?.requestId } };
    tryWriteSnapshot(opts, 'response_before_canonicalize', payload);
  } catch (error) {
    logToolGovernorNonBlocking('govern_tools_snapshot_before_canonicalize', error);
  }
  let out = processChatResponseTools(payload);
  // 变更后快照：响应侧 canonicalize 之后
  try {
    const opts: ToolGovernanceOptions = { snapshot: ctx?.snapshot || { enabled: true, endpoint: ep, requestId: ctx?.requestId } };
    tryWriteSnapshot(opts, 'response_after_canonicalize', out as any);
  } catch (error) {
    logToolGovernorNonBlocking('govern_tools_snapshot_after_canonicalize', error);
  }
  if (ep === 'responses' && ctx?.stream !== true && ctx?.produceRequiredAction !== false) {
    // 变更前快照：构造 required_action 之前
    try {
      const opts: ToolGovernanceOptions = { snapshot: ctx?.snapshot || { enabled: true, endpoint: ep, requestId: ctx?.requestId } };
      tryWriteSnapshot(opts, 'response_before_required_action', out as any);
    } catch (error) {
      logToolGovernorNonBlocking('govern_tools_snapshot_before_required_action', error);
    }
    try {
      const { buildResponsesPayloadFromChat } = require('../responses/responses-openai-bridge.js');
      const res = buildResponsesPayloadFromChat(out, { requestId: ctx?.requestId });
      try {
        const opts: ToolGovernanceOptions = { snapshot: ctx?.snapshot || { enabled: true, endpoint: ep, requestId: ctx?.requestId } };
        tryWriteSnapshot(opts, 'response_after_required_action', res as any);
      } catch (error) {
        logToolGovernorNonBlocking('govern_tools_snapshot_after_required_action', error);
      }
      return res as any;
    } catch (error) {
      logToolGovernorNonBlocking('govern_tools_required_action_bridge', error);
    }
  }
  return out;
}
