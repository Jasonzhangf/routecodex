import { describe, expect, it, jest } from '@jest/globals';

import { captureInboundContextSnapshot } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-inbound-blocks.js';
import {
  clearResponsesConversationByRequestId,
  recordResponsesResponse
} from '../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js';

describe('responses context capture fallback regression', () => {
  const requestId = 'req_responses_context_capture_fallback';

  afterEach(() => {
    clearResponsesConversationByRequestId(requestId);
  });

  it('captures responses conversation context even when stage2 did not provide responsesContext', async () => {
    const fallbackContext = {
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '继续执行' }]
        }
      ]
    };

    const hooks = {
      captureContext: jest.fn(async () => fallbackContext)
    };

    await captureInboundContextSnapshot({
      inboundStage2ResponsesContext: undefined,
      rawRequest: {
        model: 'gpt-5.3-codex',
        stream: true,
        input: '继续执行'
      } as any,
      inboundAdapterContext: {
        requestId,
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses'
      } as any,
      hooks: hooks as any
    });

    expect(hooks.captureContext).toHaveBeenCalledTimes(1);
    expect(() =>
      recordResponsesResponse({
        requestId,
        response: {
          id: 'resp_context_capture_fallback_1',
          object: 'response',
          status: 'requires_action',
          output: [
            {
              type: 'function_call',
              name: 'exec_command',
              arguments: '{"cmd":"pwd"}',
              call_id: 'call_context_capture_fallback_1'
            }
          ],
          required_action: {
            submit_tool_outputs: {
              tool_calls: [
                {
                  id: 'call_context_capture_fallback_1',
                  type: 'function',
                  name: 'exec_command',
                  arguments: '{"cmd":"pwd"}',
                  tool_call_id: 'call_context_capture_fallback_1'
                }
              ]
            }
          }
        } as any
      })
    ).not.toThrow();
  });
});
