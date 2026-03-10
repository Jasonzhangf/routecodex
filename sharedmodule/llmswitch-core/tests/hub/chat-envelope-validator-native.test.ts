import { describe, expect, test } from '@jest/globals';

import { validateChatEnvelope } from '../../src/conversion/shared/chat-envelope-validator.js';
import { validateChatEnvelopeWithNative } from '../../src/router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';

function createValidEnvelope() {
  return {
    messages: [
      {
        role: 'user',
        content: 'hello'
      }
    ],
    parameters: {
      model: 'qwen3.5-plus'
    },
    metadata: {
      context: {
        entryEndpoint: '/v1/chat/completions'
      }
    }
  } as Record<string, unknown>;
}

describe('chat-envelope validator native bridge', () => {
  test('accepts valid envelope', () => {
    const envelope = createValidEnvelope();
    expect(() =>
      validateChatEnvelope(envelope as any, {
        stage: 'req_inbound',
        direction: 'request'
      })
    ).not.toThrow();
    expect(() =>
      validateChatEnvelopeWithNative(envelope, {
        stage: 'req_inbound',
        direction: 'request'
      })
    ).not.toThrow();
  });

  test('rejects reserved field with stable error prefix', () => {
    const envelope = createValidEnvelope();
    (envelope as Record<string, unknown>).stages = {};

    expect(() =>
      validateChatEnvelopeWithNative(envelope, {
        stage: 'req_inbound',
        direction: 'request',
        source: 'native-test'
      })
    ).toThrow('ChatEnvelopeValidationError(req_inbound/request)[reserved_key]');
  });

  test('accepts responses builtin web_search tools in request envelope', () => {
    const envelope = createValidEnvelope();
    (envelope as Record<string, unknown>).tools = [
      { type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: {} } } },
      { type: 'web_search' }
    ];

    expect(() =>
      validateChatEnvelopeWithNative(envelope, {
        stage: 'req_inbound',
        direction: 'request'
      })
    ).not.toThrow();
  });

  test('accepts gemini builtin googleSearch tool shape', () => {
    const envelope = createValidEnvelope();
    (envelope as Record<string, unknown>).tools = [{ googleSearch: {} }];

    expect(() =>
      validateChatEnvelopeWithNative(envelope, {
        stage: 'req_outbound',
        direction: 'request'
      })
    ).not.toThrow();
  });
});
