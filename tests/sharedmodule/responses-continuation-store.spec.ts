import { afterEach, describe, expect, it } from '@jest/globals';
import {
  captureResponsesRequestContext,
  clearResponsesConversationByRequestId,
  materializeLatestResponsesContinuationByScope,
  recordResponsesResponse,
  resumeLatestResponsesContinuationByScope
} from '../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js';

describe('responses conversation store plain continuation restore', () => {
  const requestIds = ['req-resp-store-1', 'req-resp-store-2', 'req-resp-store-3'];

  afterEach(() => {
    for (const requestId of requestIds) {
      clearResponsesConversationByRequestId(requestId);
    }
  });

  it('restores previous_response_id by session scope when incoming input replays the exact prefix', () => {
    captureResponsesRequestContext({
      requestId: 'req-resp-store-1',
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      payload: {
        model: 'gpt-5.3-codex',
        stream: true,
        tools: [{ type: 'function', function: { name: 'exec_command' } }]
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
      requestId: 'req-resp-store-1',
      response: {
        id: 'resp-store-1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'world' }]
          }
        ]
      }
    });

    const restored = resumeLatestResponsesContinuationByScope({
      requestId: 'req-resp-store-2',
      sessionId: 'sess-1',
      payload: {
        model: 'gpt-5.3-codex',
        stream: true,
        metadata: { conversation_id: 'conv-1' },
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
      }
    });

    expect(restored).not.toBeNull();
    expect(restored?.payload.previous_response_id).toBe('resp-store-1');
    expect(restored?.payload.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'next turn' }]
      }
    ]);
    expect(restored?.meta).toMatchObject({
      previousRequestId: 'req-resp-store-1',
      restoredFromResponseId: 'resp-store-1',
      scopeKey: 'session:sess-1',
      restored: true
    });
  });

  it('returns null when no exact prefix match exists', () => {
    captureResponsesRequestContext({
      requestId: 'req-resp-store-3',
      sessionId: 'sess-x',
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
      requestId: 'req-resp-store-3',
      response: {
        id: 'resp-store-x',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'world' }]
          }
        ]
      }
    });

    const restored = resumeLatestResponsesContinuationByScope({
      requestId: 'req-resp-store-4',
      sessionId: 'sess-x',
      payload: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'different' }]
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'next turn' }]
          }
        ]
      }
    });

    expect(restored).toBeNull();
  });

  it('materializes full input by session scope for local continuation when incoming payload only carries delta', () => {
    captureResponsesRequestContext({
      requestId: 'req-resp-store-1',
      sessionId: 'sess-1',
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
      requestId: 'req-resp-store-1',
      response: {
        id: 'resp-store-materialize-1',
        output: []
      }
    });

    const materialized = materializeLatestResponsesContinuationByScope({
      requestId: 'req-resp-store-2',
      sessionId: 'sess-1',
      payload: {
        model: 'gpt-5.3-codex',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'next turn' }]
          }
        ]
      }
    });

    expect(materialized).not.toBeNull();
    expect(materialized?.payload.input).toEqual([
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
    ]);
    expect(materialized?.payload.previous_response_id).toBeUndefined();
    expect(materialized?.meta).toMatchObject({
      previousRequestId: 'req-resp-store-1',
      restoredFromResponseId: 'resp-store-materialize-1',
      scopeKey: 'session:sess-1',
      materialized: true,
      materializedMode: 'local_full_input'
    });
  });
});
