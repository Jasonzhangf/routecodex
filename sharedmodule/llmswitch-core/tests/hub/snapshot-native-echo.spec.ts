import { describe, expect, it } from '@jest/globals';
import { normalizeSnapshotStagePayloadWithNative, writeSnapshotViaHooksWithNative, shouldRecordSnapshotsWithNative } from '../../src/native/router-hotpath/native-snapshot-hooks.js';

describe('Snapshot Native Echo Tests (Layer 1)', () => {
  describe('normalizeSnapshotStagePayloadWithNative', () => {
    it('req_inbound_stage2_semantic_map with chat envelope → normalized (messages + meta)', () => {
      const payload = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        metadata: { context: 'test' },
        stream: true
      };
      const result = normalizeSnapshotStagePayloadWithNative('req_inbound_stage2_semantic_map', payload);
      expect(result).not.toBeNull();
      expect(typeof result).toBe('object');
      const obj = result as Record<string, unknown>;
      expect(obj).toHaveProperty('messages');
      expect(obj).toHaveProperty('meta');
      expect((obj.messages as Array<unknown>)[0]).toHaveProperty('content', 'hello');
      // model/stream should be filtered out
      expect(obj).not.toHaveProperty('model');
      expect(obj).not.toHaveProperty('stream');
    });

    it('req_inbound_stage2_semantic_map without metadata → passthrough (not chat envelope)', () => {
      const payload = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true
      };
      const result = normalizeSnapshotStagePayloadWithNative('req_inbound_stage2_semantic_map', payload);
      expect(result).not.toBeNull();
      expect(result).toEqual(payload);
    });

    it('resp_inbound_stage3_semantic_map → passthrough', () => {
      const payload = { id: 'resp_1', object: 'response', status: 'completed' };
      const result = normalizeSnapshotStagePayloadWithNative('resp_inbound_stage3_semantic_map', payload);
      expect(result).toEqual(payload);
    });

    it('custom stage → passthrough', () => {
      const payload = { foo: 'bar' };
      const result = normalizeSnapshotStagePayloadWithNative('custom_stage', payload);
      expect(result).toEqual(payload);
    });

    it('null payload returns null', () => {
      expect(normalizeSnapshotStagePayloadWithNative('req_inbound_stage2_semantic_map', null)).toBeNull();
    });

    it('undefined payload returns null', () => {
      expect(normalizeSnapshotStagePayloadWithNative('req_inbound_stage2_semantic_map', undefined)).toBeNull();
    });
  });

  describe('writeSnapshotViaHooksWithNative', () => {
    it('valid input does not throw', () => {
      expect(() => {
        writeSnapshotViaHooksWithNative({
          endpoint: '/v1/chat/completions',
          stage: 'req_inbound_stage2_semantic_map',
          requestId: 'test_req_echo_1',
          data: { messages: [{ role: 'user', content: 'hello' }] },
          verbosity: 'minimal',
          channel: 'test',
          providerKey: 'test.key1',
          groupRequestId: 'test_grp_echo_1',
          entryProtocol: 'openai-chat',
          entryPort: 5555,
          runtimeMetadata: { foo: 'bar' }
        });
      }).not.toThrow();
    });
  });

  describe('shouldRecordSnapshotsWithNative', () => {
    it('returns boolean', () => {
      const result = shouldRecordSnapshotsWithNative();
      expect(typeof result).toBe('boolean');
    });
  });
});
