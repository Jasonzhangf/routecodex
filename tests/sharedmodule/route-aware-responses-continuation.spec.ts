import { afterEach, describe, expect, it } from '@jest/globals';

import {
  captureResponsesRequestContext,
  clearResponsesConversationByRequestId,
  recordResponsesResponse
} from '../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js';
import { resolveRouteAwareResponsesContinuation } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.js';
import { buildResponsesRequestFromChat } from '../../sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.js';

describe('route-aware responses continuation', () => {
  const requestIds = ['req-route-aware-1', 'req-route-aware-2'];

  afterEach(() => {
    for (const requestId of requestIds) {
      clearResponsesConversationByRequestId(requestId);
    }
  });

  it('restores remote previous_response_id + deltaInput only after target resolves to responses provider', () => {
    captureResponsesRequestContext({
      requestId: 'req-route-aware-1',
      sessionId: 'sess-route-aware-1',
      payload: {
        model: 'gpt-5.3-codex'
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: 'req-route-aware-1',
      response: {
        id: 'resp-route-aware-1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'world' }]
          }
        ]
      }
    });

    const workingRequest = {
      model: 'gpt-5.3-codex',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
        { role: 'user', content: 'next turn' }
      ],
      parameters: {},
      metadata: {}
    } as any;

    const resolved = resolveRouteAwareResponsesContinuation({
      request: workingRequest,
      rawRequest: {
        model: 'gpt-5.3-codex',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }]
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'world' }]
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'next turn' }]
          }
        ]
      } as any,
      normalizedMetadata: {
        sessionId: 'sess-route-aware-1'
      },
      requestId: 'req-route-aware-2',
      entryProtocol: 'openai-responses',
      outboundProtocol: 'openai-responses'
    });

    expect((resolved as any).semantics?.responses?.resume).toMatchObject({
      previousRequestId: 'req-route-aware-1',
      restoredFromResponseId: 'resp-route-aware-1',
      restored: true
    });
    expect((resolved as any).semantics?.responses?.resume?.deltaInput).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'next turn' }]
      }
    ]);

    const outbound = buildResponsesRequestFromChat(resolved as any, {
      requestId: 'req-route-aware-2',
      metadata: {}
    });
    expect((outbound.request as any).previous_response_id).toBe('resp-route-aware-1');
    expect((outbound.request as any).input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'next turn' }]
      }
    ]);
  });

  it('does not rewrite ordinary responses request before capability is known for non-responses outbound', () => {
    captureResponsesRequestContext({
      requestId: 'req-route-aware-1',
      sessionId: 'sess-route-aware-1',
      payload: {
        model: 'gpt-5.3-codex'
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }]
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'world' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: 'req-route-aware-1',
      response: {
        id: 'resp-route-aware-1',
        output: []
      }
    });

    const workingRequest = {
      model: 'gpt-5.3-codex',
      messages: [{ role: 'user', content: 'next turn' }],
      parameters: {},
      metadata: {}
    } as any;

    const resolved = resolveRouteAwareResponsesContinuation({
      request: workingRequest,
      rawRequest: {
        model: 'gpt-5.3-codex',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'next turn' }]
          }
        ]
      } as any,
      normalizedMetadata: {
        sessionId: 'sess-route-aware-1'
      },
      requestId: 'req-route-aware-2',
      entryProtocol: 'openai-responses',
      outboundProtocol: 'anthropic-messages'
    });

    expect(resolved).not.toBe(workingRequest);
    expect((resolved as any).messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
      { role: 'user', content: 'next turn' }
    ]);
    expect((resolved as any).semantics?.responses?.resume).toMatchObject({
      previousRequestId: 'req-route-aware-1',
      restoredFromResponseId: 'resp-route-aware-1',
      materialized: true,
      materializedMode: 'local_full_input'
    });
  });

  it('preserves the already route-selected model when materializing responses continuation for non-responses outbound', () => {
    captureResponsesRequestContext({
      requestId: 'req-route-aware-1',
      sessionId: 'sess-route-aware-1',
      payload: {
        model: 'gpt-5.4'
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }]
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'world' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: 'req-route-aware-1',
      response: {
        id: 'resp-route-aware-1',
        output: []
      }
    });

    const workingRequest = {
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'next turn' }],
      parameters: {},
      metadata: {}
    } as any;

    const resolved = resolveRouteAwareResponsesContinuation({
      request: workingRequest,
      rawRequest: {
        model: 'gpt-5.4',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'next turn' }]
          }
        ]
      } as any,
      normalizedMetadata: {
        sessionId: 'sess-route-aware-1'
      },
      requestId: 'req-route-aware-2',
      entryProtocol: 'openai-responses',
      outboundProtocol: 'openai-chat-completions'
    });

    expect((resolved as any).model).toBe('qwen3.6-plus');
    expect((resolved as any).messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
      { role: 'user', content: 'next turn' }
    ]);
    expect((resolved as any).semantics?.responses?.resume).toMatchObject({
      previousRequestId: 'req-route-aware-1',
      restoredFromResponseId: 'resp-route-aware-1',
      materialized: true,
      materializedMode: 'local_full_input'
    });
  });
});
