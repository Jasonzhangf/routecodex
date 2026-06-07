import { describe, expect, test } from '@jest/globals';

import { runFollowupMainline } from '../../sharedmodule/llmswitch-core/src/servertool/backend-route-mainline-block.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

describe('servertool snapshot recording', () => {
  test('records followup request and response stages into stageRecorder', async () => {
    const stageRecords: Array<{ stage: string; payload: Record<string, unknown> }> = [];
    const adapterContext: AdapterContext = {
      requestId: 'req-servertool-snapshot-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      providerKey: 'minimax.key1.MiniMax-M3',
      stream: false,
      metadata: {
        matchedPort: 10000
      },
      capturedChatRequest: {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: '继续' }]
      }
    } as any;

    const result = await runFollowupMainline({
      adapterContext,
      requestId: 'req-servertool-snapshot-1',
      entryEndpoint: '/v1/responses',
      followupTimeoutMs: 500,
      execution: {
        flowId: 'apply_patch_flow',
        followup: {
          requestIdSuffix: ':apply_patch_followup',
          entryEndpoint: '/v1/responses',
          payload: {
            model: 'gpt-5.5',
            messages: [{ role: 'assistant', content: 'followup request' }]
          } as JsonObject
        }
      },
      finalChatResponse: {
        id: 'resp_origin_1',
        output: [{ type: 'function_call_output', call_id: 'call_1', output: 'ok' }]
      } as JsonObject,
      flowId: 'apply_patch_flow',
      totalSteps: 5,
      stopMessageLoopWarnThreshold: 5,
      stopMessageLoopFailThreshold: 10,
      stageRecorder: {
        record(stage: string, payload: object) {
          stageRecords.push({ stage, payload: payload as Record<string, unknown> });
        }
      },
      reenterPipeline: async () => ({
        body: {
          id: 'resp_followup_1',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }]
        } as JsonObject
      }),
      clientInjectDispatch: async () => ({ ok: true }),
      onLogProgress: () => {},
      logNonBlocking: () => {}
    });

    expect(result.executed).toBe(true);
    expect(stageRecords.some((entry) => entry.stage === 'servertool.followup.request')).toBe(true);
    expect(stageRecords.some((entry) => entry.stage === 'hub_followup.response')).toBe(true);

    const requestRecord = stageRecords.find((entry) => entry.stage === 'servertool.followup.request');
    expect(requestRecord?.payload.flowId).toBe('apply_patch_flow');
    expect(requestRecord?.payload.executionMode).toBe('reenter');
    expect(requestRecord?.payload.followupEntryEndpoint).toBe('/v1/responses');
  });
});
