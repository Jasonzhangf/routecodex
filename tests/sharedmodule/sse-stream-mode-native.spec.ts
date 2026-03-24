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

  test('enables stream when gemini-chat protocol has surrounding whitespace', () => {
    const result = processSseStreamWithNative({
      clientPayload: { id: 'resp_gemini_trim', object: 'response' },
      clientProtocol: ' gemini-chat ',
      requestId: 'req_gemini_stream_trim',
      wantsStream: true
    });

    expect(result.shouldStream).toBe(true);
    expect(result.payload).toEqual({ id: 'resp_gemini_trim', object: 'response' });
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

  test('resolve/process native stream decisions stay aligned for gemini-chat variants', () => {
    const protocols = ['gemini-chat', ' gemini-chat '];
    for (const protocol of protocols) {
      for (const wantsStream of [true, false]) {
        const resolved = resolveSseStreamModeWithNative(wantsStream, protocol);
        const processed = processSseStreamWithNative({
          clientPayload: { id: `resp_${protocol.trim()}_${String(wantsStream)}` },
          clientProtocol: protocol,
          requestId: `req_${protocol.trim()}_${String(wantsStream)}`,
          wantsStream
        });
        expect(processed.shouldStream).toBe(resolved);
      }
    }
  });

  test('resolve/process native stream decisions stay aligned for unknown protocol variants', () => {
    const protocols = ['unknown-protocol', ' unknown-protocol ', 'gemini-chat-preview'];
    for (const protocol of protocols) {
      for (const wantsStream of [true, false]) {
        const resolved = resolveSseStreamModeWithNative(wantsStream, protocol);
        const processed = processSseStreamWithNative({
          clientPayload: { id: `resp_${protocol.trim()}_${String(wantsStream)}` },
          clientProtocol: protocol,
          requestId: `req_${protocol.trim()}_${String(wantsStream)}`,
          wantsStream
        });
        expect(processed.shouldStream).toBe(false);
        expect(processed.shouldStream).toBe(resolved);
      }
    }
  });
});
