import { describe, expect, it } from '@jest/globals';

import {
  applyMetadataCenterRustWriteResult,
  buildMetadataCenterRustSnapshot,
  readMetadataCenterSlot,
  releaseMetadataCenterSlot,
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
  it('keeps the compatibility metadata center mirror non-enumerable', () => {
    const target: Record<string, unknown> = {};

    writeMetadataCenterSlot({
      target,
      family: 'request_truth',
      key: 'requestId',
      value: 'req-non-enumerable',
      writer: TEST_WRITER
    });

    expect(MetadataCenter.read(target)?.readRequestTruth().requestId).toBe('req-non-enumerable');
    expect(Object.keys(target)).not.toContain('__metadataCenter');
    expect({ ...target }).not.toHaveProperty('__metadataCenter');
    expect(JSON.stringify(target)).not.toContain('__metadataCenter');
    expect(Object.getOwnPropertyDescriptor(target, '__metadataCenter')).toEqual(
      expect.objectContaining({ enumerable: false })
    );
  });

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

  it('releases runtime_control slots from both JS mirror and Rust-readable snapshot', () => {
    const target: Record<string, unknown> = {};

    writeMetadataCenterSlot({
      target,
      family: 'runtime_control',
      key: 'preselectedRoute',
      value: {
        target: {
          providerKey: 'primary.key1.gpt-5.3-codex'
        },
        decision: {
          providerProtocol: 'openai-responses'
        }
      },
      writer: TEST_WRITER
    });
    writeMetadataCenterSlot({
      target,
      family: 'runtime_control',
      key: 'providerProtocol',
      value: 'openai-responses',
      writer: TEST_WRITER
    });

    releaseMetadataCenterSlot({
      target,
      family: 'runtime_control',
      key: 'preselectedRoute',
      writer: TEST_WRITER,
      reason: 'retry must release preselected route truth'
    });
    releaseMetadataCenterSlot({
      target,
      family: 'runtime_control',
      key: 'providerProtocol',
      writer: TEST_WRITER,
      reason: 'retry must release provider protocol truth'
    });

    expect(MetadataCenter.read(target)?.readRuntimeControl().preselectedRoute).toBeUndefined();
    expect(MetadataCenter.read(target)?.readRuntimeControl().providerProtocol).toBeUndefined();
    expect(buildMetadataCenterRustSnapshot(target).runtimeControl?.preselectedRoute).toBeUndefined();
    expect(buildMetadataCenterRustSnapshot(target).runtimeControl?.providerProtocol).toBeUndefined();
  });

  it('applies Rust write result into both JS mirror and Rust-readable snapshot', () => {
    const target: Record<string, unknown> = {};
    seedRequestTruth(target, 'req-rust-write', 'sess-rust-write');

    applyMetadataCenterRustWriteResult({
      target,
      snapshot: {
        runtimeControl: {
          stopless: {
            flowId: 'stop_message_flow',
            repeatCount: 2,
            maxRepeats: 3,
            triggerHint: 'invalid_schema',
            active: true
          }
        },
        providerObservation: {
          providerKey: 'provider.key.model'
        },
        responseObservation: {
          finishReason: 'tool_calls'
        },
        closeoutStatus: {
          finalized: true
        }
      },
      writer: TEST_WRITER,
      reason: 'rust write result contract'
    });

    expect(MetadataCenter.read(target)?.readRuntimeControl().stopless).toEqual(
      expect.objectContaining({
        repeatCount: 2,
        maxRepeats: 3,
        triggerHint: 'invalid_schema'
      })
    );
    expect(MetadataCenter.read(target)?.readProviderObservation().providerKey).toBe('provider.key.model');
    expect(MetadataCenter.read(target)?.readResponseObservation().finishReason).toBe('tool_calls');
    expect(MetadataCenter.read(target)?.readCloseoutStatus().finalized).toBe(true);
    expect(buildMetadataCenterRustSnapshot(target)).toEqual(expect.objectContaining({
      runtimeControl: expect.objectContaining({
        stopless: expect.objectContaining({ repeatCount: 2 })
      }),
      providerObservation: expect.objectContaining({
        providerKey: 'provider.key.model'
      }),
      responseObservation: expect.objectContaining({
        finishReason: 'tool_calls'
      }),
      closeoutStatus: expect.objectContaining({
        finalized: true
      })
    }));
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

  it('dual-writes explicit stopless migration mirror and compare context only when the API is asked to write them', () => {
    const target: Record<string, unknown> = {};

    writeMetadataCenterSlot({
      target,
      family: 'runtime_control',
      key: 'serverToolLoopState',
      value: {
        flowId: 'stop_message_flow',
        repeatCount: 2,
        maxRepeats: 3
      },
      writer: TEST_WRITER
    });
    writeMetadataCenterSlot({
      target,
      family: 'runtime_control',
      key: 'stopMessageCompareContext',
      value: {
        decision: 'trigger',
        reason: 'stop_schema_missing',
        used: 2,
        remaining: 1
      },
      writer: TEST_WRITER
    });

    expect(MetadataCenter.read(target)?.readRuntimeControl()).toEqual(expect.objectContaining({
      serverToolLoopState: expect.objectContaining({ repeatCount: 2 }),
      stopMessageCompareContext: expect.objectContaining({ reason: 'stop_schema_missing' })
    }));
    expect(buildMetadataCenterRustSnapshot(target).runtimeControl).toEqual(expect.objectContaining({
      serverToolLoopState: expect.objectContaining({ maxRepeats: 3 }),
      stopMessageCompareContext: expect.objectContaining({ used: 2 })
    }));
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
