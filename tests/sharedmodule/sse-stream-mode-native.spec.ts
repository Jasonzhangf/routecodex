import { describe, expect, test } from '@jest/globals';

import {
  processSseStreamWithNative,
  resolveSseStreamModeWithNative
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';

describe('sse stream mode native bridge', () => {
  test('enables stream for openai-responses protocol when wantsStream=true', () => {
    const result = processSseStreamWithNative({
      clientPayload: { id: 'resp_1', object: 'response' },
      clientProtocol: 'openai-responses',
      requestId: 'req_stream_on',
      wantsStream: true
    });

    expect(result.shouldStream).toBe(true);
    expect(result.payload).toEqual({ id: 'resp_1', object: 'response' });
  });

  test('enables stream for gemini-chat protocol when wantsStream=true', () => {
    const result = processSseStreamWithNative({
      clientPayload: { id: 'resp_gemini', object: 'response', model: 'gemini-2.5-pro' },
      clientProtocol: 'gemini-chat',
      requestId: 'req_gemini_stream_on',
      wantsStream: true
    });

    expect(result.shouldStream).toBe(true);
    expect(result.payload).toEqual({
      id: 'resp_gemini',
      object: 'response',
      model: 'gemini-2.5-pro'
    });
  });

  test('disables stream for unknown protocol even when wantsStream=true', () => {
    const result = processSseStreamWithNative({
      clientPayload: { id: 'resp_2' },
      clientProtocol: 'unknown-protocol',
      requestId: 'req_stream_off',
      wantsStream: true
    });

    expect(result.shouldStream).toBe(false);
    expect(result.payload).toEqual({ id: 'resp_2' });
  });

  test('resolveSseStreamModeWithNative supports gemini-chat', () => {
    expect(resolveSseStreamModeWithNative(true, 'gemini-chat')).toBe(true);
    expect(resolveSseStreamModeWithNative(false, 'gemini-chat')).toBe(false);
  });
});
