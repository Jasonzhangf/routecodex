import { describe, expect, it } from '@jest/globals';

import { projectResponsesSseFrameForClientNative } from '../../../../src/modules/llmswitch/bridge/native-exports.js';

describe('native-exports responses SSE contract', () => {
  it('calls router_hotpath SSE projection with the native multi-arg contract', () => {
    const projected = projectResponsesSseFrameForClientNative({
      frame: 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      eventName: 'response.created',
      data: {
        type: 'response.created',
        response: {
          id: 'resp_1',
          object: 'response',
          status: 'in_progress',
        },
      },
      toolsRaw: [],
      metadata: {},
      state: {
        pendingApplyPatchArgumentDeltas: {},
        applyPatchCallIds: [],
        emittedApplyPatchDoneCallIds: [],
      },
    });

    expect(projected).toEqual(
      expect.objectContaining({
        emit: expect.any(Boolean),
        frame: expect.any(String),
        state: expect.objectContaining({
          pendingApplyPatchArgumentDeltas: expect.any(Object),
          applyPatchCallIds: expect.any(Array),
          emittedApplyPatchDoneCallIds: expect.any(Array),
        }),
      })
    );
  });
});
