import { describe, expect, it, jest } from '@jest/globals';

import { recordOutboundToolParityObservation } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-provider-payload-observation.js';

describe('hub pipeline provider payload observation', () => {
  it('records tool parity and message tool history from inbound raw body and outbound payload', () => {
    const record = jest.fn();

    recordOutboundToolParityObservation({
      rawRequest: {
        data: {
          tools: [
            { type: 'function', function: { name: 'exec_command' } },
            { type: 'function', function: { name: 'apply_patch' } },
          ],
          messages: [
            {
              role: 'assistant',
              tool_calls: [{ id: 'call_1' }, { id: 'call_2' }],
            },
            {
              role: 'tool',
              tool_call_id: 'call_1',
            },
            {
              role: 'tool',
              call_id: 'call_2',
            },
          ],
        },
      } as any,
      providerPayload: {
        tools: [
          { type: 'function', function: { name: 'exec_command' } },
          { type: 'function', function: { name: 'computer_use' } },
        ],
        messages: [
          {
            role: 'assistant',
            tool_calls: [{ id: 'call_1' }],
          },
          {
            role: 'tool',
            tool_call_id: 'call_1',
          },
        ],
      },
      providerProtocol: 'openai-chat',
      compatibilityProfile: 'compat-test',
      requestId: 'req_tool_parity',
      stageRecorder: { record } as any,
    });

    expect(record).toHaveBeenCalledWith(
      'chat_process.req.stage8b.outbound.tool_parity',
      {
        requestId: 'req_tool_parity',
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'compat-test',
        inboundTools: {
          count: 2,
          names: ['exec_command', 'apply_patch'],
        },
        outboundTools: {
          count: 2,
          names: ['exec_command', 'computer_use'],
        },
        missingNames: ['apply_patch'],
        extraNames: ['computer_use'],
        matched: false,
        inboundHistory: {
          messageCount: 3,
          assistantToolCallTurns: 1,
          assistantToolCallCount: 2,
          toolResultTurns: 2,
          toolResultIds: ['call_1', 'call_2'],
        },
        outboundHistory: {
          messageCount: 2,
          assistantToolCallTurns: 1,
          assistantToolCallCount: 1,
          toolResultTurns: 1,
          toolResultIds: ['call_1'],
        },
      },
    );
  });

  it('does nothing when stage recorder is absent', () => {
    expect(() =>
      recordOutboundToolParityObservation({
        rawRequest: {} as any,
        providerPayload: {},
        providerProtocol: 'openai-chat',
        requestId: 'req_noop',
      }),
    ).not.toThrow();
  });
});
