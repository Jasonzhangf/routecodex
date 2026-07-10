import { describe, expect, it } from '@jest/globals';
import { materializeProviderResponseSsePayloadWithNative } from '../../../../tests/sharedmodule/helpers/resp-semantics-direct-native.js';
import { buildProviderSseStreamReadErrorDescriptorWithNative } from '../../../../tests/sharedmodule/helpers/resp-semantics-direct-native.js';

describe('Response Semantics Native Echo Tests (Layer 2)', () => {
  describe('materializeProviderResponseSsePayloadWithNative', () => {
    it('SSE payload with bodyText → materialized', () => {
      const result = materializeProviderResponseSsePayloadWithNative({
        payload: { sseStream: true, trace: 'echo-test' },
        streamBodyText: 'data: {"id":"resp_1"}\n\ndata: [DONE]\n\n'
      });
      expect(result).not.toBeNull();
      expect(result).toHaveProperty('mode', 'sse');
      expect(result.bodyText).toContain('resp_1');
      expect(result).toHaveProperty('trace', 'echo-test');
    });

    it('Non-SSE payload → passthrough', () => {
      const result = materializeProviderResponseSsePayloadWithNative({
        payload: { id: 'resp_1', object: 'response', status: 'completed' },
        streamBodyText: undefined
      });
      expect(result).toEqual({ id: 'resp_1', object: 'response', status: 'completed' });
    });

    it('SSE marker with raw text → materialized', () => {
      const result = materializeProviderResponseSsePayloadWithNative({
        payload: { mode: 'sse', raw: 'event: completed\ndata: {}\n\n' },
        streamBodyText: undefined
      });
      expect(result).toHaveProperty('mode', 'sse');
      expect(result).toHaveProperty('bodyText');
      expect(result.bodyText).toContain('event: completed');
    });

    it('null payload → throws via failNative', () => {
      expect(() => {
        materializeProviderResponseSsePayloadWithNative({ payload: null, streamBodyText: undefined });
      }).toThrow();
    });
  });

  describe('buildProviderSseStreamReadErrorDescriptorWithNative', () => {
    it('returns structured error with upstream code', () => {
      const result = buildProviderSseStreamReadErrorDescriptorWithNative({
        message: 'Stream read failed',
        code: 'SSE_READ_TIMEOUT',
        upstreamCode: 'UPSTREAM_TIMEOUT'
      });
      expect(result).toHaveProperty('code', 'SSE_DECODE_ERROR');
      expect(result).toHaveProperty('upstreamCode', 'UPSTREAM_TIMEOUT');
      expect(result).toHaveProperty('statusCode', 502);
      expect(result).toHaveProperty('retryable', true);
    });

    it('terminated stream marked appropriately', () => {
      const result = buildProviderSseStreamReadErrorDescriptorWithNative({
        message: 'Upstream terminated',
        code: 'terminated',
        upstreamCode: undefined
      });
      expect(result).toHaveProperty('code', 'SSE_DECODE_ERROR');
      expect(result).toHaveProperty('upstreamCode', 'UPSTREAM_STREAM_TERMINATED');
    });
  });
});
