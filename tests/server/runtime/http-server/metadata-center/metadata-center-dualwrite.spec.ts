import { describe, expect, it } from '@jest/globals';

import {
  buildMetadataCenterRustSnapshot,
  readMetadataCenterSlot,
  writeMetadataCenterSlot
} from '../../../../../src/server/runtime/http-server/metadata-center/dualwrite-api.ts';
import {
  MetadataCenter,
  readReleasedMetadataCenterSessionBuffer,
  releaseMetadataCenterForHttpResponse
} from '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.ts';

const TEST_WRITER = {
  module: 'tests/server/runtime/http-server/metadata-center/metadata-center-dualwrite.spec.ts',
  symbol: 'metadata-center-dualwrite',
  stage: 'test'
};

function seedRequestTruth(target: Record<string, unknown>, requestId: string, sessionId: string): void {
  writeMetadataCenterSlot({
    target,
    family: 'request_truth',
    key: 'requestId',
    value: requestId,
    writer: TEST_WRITER
  });
  writeMetadataCenterSlot({
    target,
    family: 'request_truth',
    key: 'sessionId',
    value: sessionId,
    writer: TEST_WRITER
  });
}

describe('metadata center dual-write API', () => {
  it('writes runtime_control.stopless into JS mirror and Rust-readable snapshot in one call', () => {
    const target: Record<string, unknown> = {};

    writeMetadataCenterSlot({
      target,
      family: 'runtime_control',
      key: 'stopless',
      value: {
        flowId: 'stop_message_flow',
        repeatCount: 1,
        maxRepeats: 3,
        triggerHint: 'no_schema',
        continuationPrompt: '继续执行',
        schemaFeedback: { reasonCode: 'stop_schema_missing' },
        active: true
      },
      writer: TEST_WRITER,
      reason: 'dualwrite-contract'
    });

    expect(MetadataCenter.read(target)?.readRuntimeControl().stopless).toEqual(
      expect.objectContaining({
        flowId: 'stop_message_flow',
        repeatCount: 1,
        maxRepeats: 3,
        active: true
      })
    );
    expect(buildMetadataCenterRustSnapshot(target).runtimeControl?.stopless).toEqual(
      expect.objectContaining({
        flowId: 'stop_message_flow',
        repeatCount: 1,
        maxRepeats: 3,
        triggerHint: 'no_schema'
      })
    );
    expect(readMetadataCenterSlot({
      source: target,
      family: 'runtime_control',
      key: 'stopless'
    })).toEqual(expect.objectContaining({ repeatCount: 1 }));
  });

  it('does not materialize legacy stopmessage mirrors from the canonical stopless slot', () => {
    const target: Record<string, unknown> = {};

    writeMetadataCenterSlot({
      target,
      family: 'runtime_control',
      key: 'stopless',
      value: {
        flowId: 'stop_message_flow',
        repeatCount: 2,
        maxRepeats: 3,
        active: true
      },
      writer: TEST_WRITER
    });

    expect(MetadataCenter.read(target)?.readRuntimeControl().stopless).toEqual({
      flowId: 'stop_message_flow',
      repeatCount: 2,
      maxRepeats: 3,
      active: true
    });
    expect(MetadataCenter.read(target)?.readRuntimeControl().serverToolLoopState).toBeUndefined();
    expect((buildMetadataCenterRustSnapshot(target).runtimeControl as any)?.serverToolLoopState).toBeUndefined();
    expect((buildMetadataCenterRustSnapshot(target).runtimeControl as any)?.stopMessageState).toBeUndefined();
  });

  it('keeps runtime control isolated by request-local target and explicit request/session scope', () => {
    const first: Record<string, unknown> = {};
    const second: Record<string, unknown> = {};
    seedRequestTruth(first, 'req-a', 'sess-a');
    seedRequestTruth(second, 'req-b', 'sess-b');

    writeMetadataCenterSlot({
      target: first,
      family: 'runtime_control',
      key: 'stopless',
      value: {
        flowId: 'stop_message_flow',
        repeatCount: 1,
        maxRepeats: 3,
        active: true
      },
      writer: TEST_WRITER,
      expectedScope: { requestId: 'req-a', sessionId: 'sess-a' }
    });
    writeMetadataCenterSlot({
      target: second,
      family: 'runtime_control',
      key: 'stopless',
      value: {
        flowId: 'stop_message_flow',
        repeatCount: 2,
        maxRepeats: 3,
        active: true
      },
      writer: TEST_WRITER,
      expectedScope: { requestId: 'req-b', sessionId: 'sess-b' }
    });

    expect(readMetadataCenterSlot({
      source: first,
      family: 'runtime_control',
      key: 'stopless',
      expectedScope: { requestId: 'req-a', sessionId: 'sess-a' }
    })).toEqual(expect.objectContaining({ repeatCount: 1 }));
    expect(readMetadataCenterSlot({
      source: second,
      family: 'runtime_control',
      key: 'stopless',
      expectedScope: { requestId: 'req-b', sessionId: 'sess-b' }
    })).toEqual(expect.objectContaining({ repeatCount: 2 }));
  });

  it('fails fast on request/session scope mismatch instead of reading another session metadata', () => {
    const target: Record<string, unknown> = {};
    seedRequestTruth(target, 'req-scope-owner', 'sess-scope-owner');

    expect(() => writeMetadataCenterSlot({
      target,
      family: 'runtime_control',
      key: 'stopless',
      value: {
        flowId: 'stop_message_flow',
        repeatCount: 1,
        maxRepeats: 3,
        active: true
      },
      writer: TEST_WRITER,
      expectedScope: { requestId: 'req-other', sessionId: 'sess-scope-owner' }
    })).toThrow(/requestId expected=req-other actual=req-scope-owner/);

    expect(() => readMetadataCenterSlot({
      source: target,
      family: 'runtime_control',
      key: 'stopless',
      expectedScope: { requestId: 'req-scope-owner', sessionId: 'sess-other' }
    })).toThrow(/sessionId expected=sess-other actual=sess-scope-owner/);
  });

  it('records released metadata in a bounded per-session lifecycle buffer without changing live reads', () => {
    const sessionId = `sess-buffer-${Date.now()}`;
    for (let index = 0; index < 12; index += 1) {
      const target: Record<string, unknown> = {};
      seedRequestTruth(target, `req-buffer-${index}`, sessionId);
      writeMetadataCenterSlot({
        target,
        family: 'runtime_control',
        key: 'routeHint',
        value: `tools-${index}`,
        writer: TEST_WRITER,
        expectedScope: { requestId: `req-buffer-${index}`, sessionId }
      });
      releaseMetadataCenterForHttpResponse(target, `release-${index}`);
    }

    const entries = readReleasedMetadataCenterSessionBuffer(sessionId);
    expect(entries).toHaveLength(10);
    expect(entries[0]?.requestId).toBe('req-buffer-2');
    expect(entries.at(-1)?.requestId).toBe('req-buffer-11');
    expect(entries.at(-1)?.state.runtimeControl.routeHint?.status).toBe('released');
  });
});
