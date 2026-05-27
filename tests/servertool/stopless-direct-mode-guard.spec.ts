/**
 * Red-test: stopless must NOT fire in direct mode (allowFollowup=false).
 * In relay mode (allowFollowup=undefined/true), stopless CAN fire.
 */

import { describe, test, expect } from '@jest/globals';
import { runServertoolResponseStageOrchestrationShell } from '../../sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.js';

function makeStopEligiblePayload() {
  return {
    id: 'resp_test',
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }]
  };
}

function makeAdapterContext(): Record<string, unknown> {
  return {
    requestId: 'test-req',
    __rt: {
      // Relay mode sets serverToolFollowup. Direct mode does not.
    }
  };
}

describe('stopless direct mode guard', () => {
  test('RED: allowFollowup=false → stopless skip (direct mode)', async () => {
    const result = await runServertoolResponseStageOrchestrationShell({
      payload: makeStopEligiblePayload() as any,
      adapterContext: makeAdapterContext() as any,
      requestId: 'test-req',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      allowFollowup: false,  // DIRECT MODE
    });

    // In direct mode, stopless must NOT fire.
    // If this test fails, stopless is leaking into direct mode.
    expect(result.skipReason).toBe('direct_mode_no_followup');
    expect(result.executed).toBe(false);
  });

  test('allowFollowup=undefined → stopless CAN fire (relay mode default)', async () => {
    const result = await runServertoolResponseStageOrchestrationShell({
      payload: makeStopEligiblePayload() as any,
      adapterContext: makeAdapterContext() as any,
      requestId: 'test-req',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      // allowFollowup undefined = relay mode
    });

    // In relay mode (default), stopless should not be blocked by direct mode guard.
    // The skip reason should NOT be direct_mode_no_followup.
    // (It might still skip for other reasons like no_servertool_support)
    expect(result.skipReason).not.toBe('direct_mode_no_followup');
  });
});
