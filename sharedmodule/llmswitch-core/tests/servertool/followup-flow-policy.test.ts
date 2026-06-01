import { describe, expect, test } from '@jest/globals';

import {
  isClientInjectOnlyFollowupFlowId,
  isNoFollowupFlowId,
  resolveFollowupFlowDecision,
  shouldRetryEmptyFollowupOnce,
  isStickyProviderFollowupFlowId,
  resolveContextDecorationModeForFlowId,
  resolveClientInjectSourceForFlowId,
  resolveTransparentReplayRequestSuffixForFlowId,
  shouldIgnoreRequiresActionFollowup
} from '../../src/servertool/followup-flow-policy.js';
import {
  resolveProgressToolName,
  shouldUseGoldProgressHighlight
} from '../../src/servertool/flow-presentation-block.js';

describe('servertool followup flow policy', () => {
  test('reads transparent replay suffix from skeleton config', () => {
    expect(resolveTransparentReplayRequestSuffixForFlowId('antigravity_thought_signature_bootstrap'))
      .toBe(':antigravity_ts_replay');
  });

  test('treats antigravity bootstrap as sticky provider flow via config', () => {
    expect(isStickyProviderFollowupFlowId('antigravity_thought_signature_bootstrap')).toBe(true);
  });

  test('stop_message_flow does not ignore requires_action followups', () => {
    expect(shouldIgnoreRequiresActionFollowup('stop_message_flow')).toBe(false);
  });

  test('reads no-followup policy from skeleton profiles', () => {
    expect(isNoFollowupFlowId('reasoning_stop_finalize_flow')).toBe(true);
    expect(resolveFollowupFlowDecision('reasoning_stop_finalize_flow').outcomeMode).toBe('skip');
  });

  test('reads retry-empty-followup policy from skeleton profiles', () => {
    expect(shouldRetryEmptyFollowupOnce('stop_message_flow')).toBe(true);
  });

  test('reads context decoration mode from skeleton config', () => {
    expect(resolveContextDecorationModeForFlowId('continue_execution_flow')).toBe('continue_execution_summary');
    expect(resolveContextDecorationModeForFlowId('web_search_flow')).toBe('web_search_summary');
  });

  test('reads gold highlight flow ids from skeleton config', () => {
    expect(shouldUseGoldProgressHighlight('continue_execution_flow')).toBe(true);
  });
});
