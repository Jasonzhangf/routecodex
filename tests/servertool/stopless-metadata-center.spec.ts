import { describe, expect, it } from '@jest/globals';

import {
  buildMetadataCenterRustSnapshot,
  readMetadataCenterSlot,
  writeMetadataCenterSlot,
} from '../../src/server/runtime/http-server/metadata-center/dualwrite-api.ts';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.ts';

const TEST_WRITER = {
  module: 'tests/servertool/stopless-metadata-center.spec.ts',
  symbol: 'stopless-metadata-center',
  stage: 'test',
} as const;

function seedRequestTruth(target: Record<string, unknown>, requestId: string, sessionId: string): void {
  writeMetadataCenterSlot({
    target,
    family: 'request_truth',
    key: 'requestId',
    value: requestId,
    writer: TEST_WRITER,
  });
  writeMetadataCenterSlot({
    target,
    family: 'request_truth',
    key: 'sessionId',
    value: sessionId,
    writer: TEST_WRITER,
  });
}

function writeStoplessRound(target: Record<string, unknown>, requestId: string, sessionId: string, repeatCount: number): void {
  writeMetadataCenterSlot({
    target,
    family: 'runtime_control',
    key: 'stopless',
    value: {
      flowId: 'stop_message_flow',
      repeatCount,
      maxRepeats: 3,
      triggerHint: repeatCount === 1 ? 'no_schema' : 'invalid_schema',
      active: repeatCount < 3,
    },
    writer: TEST_WRITER,
    reason: `stopless round ${repeatCount}`,
    expectedScope: { requestId, sessionId },
  });
}

describe('stopless MetadataCenter progression', () => {
  it('dual-writes stopless repeatCount through 1 -> 2 -> 3 without resetting across request scope', () => {
    const target: Record<string, unknown> = {};
    seedRequestTruth(target, 'req-stopless-1', 'sess-stopless-1');

    for (const repeatCount of [1, 2, 3]) {
      writeStoplessRound(target, 'req-stopless-1', 'sess-stopless-1', repeatCount);

      expect(readMetadataCenterSlot({
        source: target,
        family: 'runtime_control',
        key: 'stopless',
        expectedScope: { requestId: 'req-stopless-1', sessionId: 'sess-stopless-1' },
      })).toEqual(expect.objectContaining({ repeatCount, maxRepeats: 3 }));
      expect(MetadataCenter.read(target)?.readRuntimeControl().stopless).toEqual(
        expect.objectContaining({ repeatCount, maxRepeats: 3 })
      );
      expect(buildMetadataCenterRustSnapshot(target).runtimeControl?.stopless).toEqual(
        expect.objectContaining({ repeatCount, maxRepeats: 3 })
      );
    }
  });

  it('fails fast instead of reading stopless state across sessions', () => {
    const first: Record<string, unknown> = {};
    const second: Record<string, unknown> = {};
    seedRequestTruth(first, 'req-stopless-a', 'sess-stopless-a');
    seedRequestTruth(second, 'req-stopless-b', 'sess-stopless-b');
    writeStoplessRound(first, 'req-stopless-a', 'sess-stopless-a', 2);
    writeStoplessRound(second, 'req-stopless-b', 'sess-stopless-b', 1);

    expect(() => readMetadataCenterSlot({
      source: first,
      family: 'runtime_control',
      key: 'stopless',
      expectedScope: { requestId: 'req-stopless-a', sessionId: 'sess-stopless-b' },
    })).toThrow(/sessionId expected=sess-stopless-b actual=sess-stopless-a/);

    expect(readMetadataCenterSlot({
      source: second,
      family: 'runtime_control',
      key: 'stopless',
      expectedScope: { requestId: 'req-stopless-b', sessionId: 'sess-stopless-b' },
    })).toEqual(expect.objectContaining({ repeatCount: 1 }));
  });
});
