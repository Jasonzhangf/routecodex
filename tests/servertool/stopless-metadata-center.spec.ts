import { describe, expect, it } from '@jest/globals';

import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import { writeStoplessRuntimeControl } from '../../src/server/runtime/http-server/metadata-center/request-truth-readers.ts';
import { writeStoplessRuntimeControlToBoundMetadataCenter } from '../../sharedmodule/llmswitch-core/src/servertool/stopless-metadata-carrier.ts';

describe('stopless metadata center helper', () => {
  it('writes stopless runtime control into MetadataCenter as the request-local control truth', () => {
    const metadata: Record<string, unknown> = {};

    writeStoplessRuntimeControl({
      metadata,
      value: {
        sessionId: 'sess-stopless-bridge-1',
        flowId: 'stop_message_flow',
        repeatCount: 2,
        maxRepeats: 3,
        continuationPrompt: '继续做下一步；先把手头能确认的结果拿回来。',
        active: true
      },
      writer: {
        module: 'tests/servertool/stopless-metadata-center.spec.ts',
        symbol: 'writes stopless runtime control into MetadataCenter as the request-local control truth',
        stage: 'test'
      }
    });

    const center = MetadataCenter.read(metadata);
    expect(center?.readRuntimeControl().stopless).toEqual(
      expect.objectContaining({
        sessionId: 'sess-stopless-bridge-1',
        flowId: 'stop_message_flow',
        repeatCount: 2,
        maxRepeats: 3,
        continuationPrompt: '继续做下一步；先把手头能确认的结果拿回来。',
        active: true
      })
    );
  });

  it('writes through the sharedmodule metadata side-channel when a MetadataCenter is already bound', () => {
    const metadata: Record<string, unknown> = {};
    MetadataCenter.attach(metadata);

    writeStoplessRuntimeControlToBoundMetadataCenter({
      metadata,
      value: {
        sessionId: 'sess-stopless-sidechannel-1',
        flowId: 'stop_message_flow',
        repeatCount: 1,
        maxRepeats: 3,
        continuationPrompt: '继续执行',
        active: true
      },
      writer: {
        module: 'tests/servertool/stopless-metadata-center.spec.ts',
        symbol: 'writes through the sharedmodule metadata side-channel when a MetadataCenter is already bound',
        stage: 'test'
      },
      reason: 'test-side-channel'
    });

    const center = MetadataCenter.read(metadata);
    expect(center?.readRuntimeControl().stopless).toEqual(
      expect.objectContaining({
        sessionId: 'sess-stopless-sidechannel-1',
        flowId: 'stop_message_flow',
        repeatCount: 1,
        maxRepeats: 3,
        continuationPrompt: '继续执行',
        active: true
      })
    );
  });

  it('fails fast when a required stopless runtime control write has no MetadataCenter binding', () => {
    const metadata: Record<string, unknown> = {};

    expect(() =>
      writeStoplessRuntimeControlToBoundMetadataCenter({
        metadata,
        value: {
          sessionId: 'sess-stopless-required-1',
          flowId: 'stop_message_flow',
          repeatCount: 1,
          maxRepeats: 3,
          continuationPrompt: '继续执行',
          active: true
        },
        writer: {
          module: 'tests/servertool/stopless-metadata-center.spec.ts',
          symbol: 'fails fast when a required stopless runtime control write has no MetadataCenter binding',
          stage: 'test'
        },
        reason: 'test-required-side-channel',
        required: true
      })
    ).toThrow(/requires a bound MetadataCenter/);
  });
});
