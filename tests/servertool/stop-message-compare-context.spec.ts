import { describe, expect, test } from '@jest/globals';

import {
  attachStopMessageCompareContext,
  readStopMessageCompareContext,
  type StopMessageCompareContext
} from '../../sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.js';
import {
  formatStopMessageCompareContextWithNative
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.ts';

const BASE_CONTEXT: StopMessageCompareContext = {
  armed: true,
  mode: 'auto',
  allowModeOnly: false,
  textLength: 12,
  maxRepeats: 3,
  used: 1,
  remaining: 2,
  active: true,
  stopEligible: true,
  hasCapturedRequest: true,
  compactionRequest: false,
  hasSeed: true,
  decision: 'trigger',
  reason: 'native_decision'
};

const NORMALIZED_BASE_CONTEXT = {
  armed: true,
  mode: 'auto',
  allowModeOnly: false,
  textLength: 12,
  maxRepeats: 3,
  used: 1,
  remaining: 2,
  active: true,
  stopEligible: true,
  compactionRequest: false,
  hasSeed: true,
  decision: 'trigger',
  reason: 'native_decision'
};

const TEST_WRITER = {
  module: 'tests/servertool/stop-message-compare-context.spec.ts',
  symbol: 'test',
  stage: 'HubRespChatProcess03Governed'
} as const;

function makeAdapterWithCompareContext(value: Record<string, unknown>): Record<string, unknown> {
  const adapterContext: Record<string, unknown> = {};
  const center = MetadataCenter.attach(adapterContext);
  center.writeRuntimeControl('stopMessageCompareContext', value, TEST_WRITER, 'test compare context');
  return adapterContext;
}

describe('servertool stop-message compare context', () => {
  test('reads MetadataCenter runtime_control compare context through native normalization', () => {
    const context = readStopMessageCompareContext(makeAdapterWithCompareContext({
      ...BASE_CONTEXT,
      mode: ' ON ',
      textLength: 12.9,
      maxRepeats: 3.8,
      used: 1.2,
      decision: ' TRIGGER ',
      reason: ' native_decision ',
      stage: ' match ',
      observationStableCount: 2.7
    }));

    expect(context).toEqual({
      ...NORMALIZED_BASE_CONTEXT,
      mode: 'on',
      textLength: 12,
      maxRepeats: 3,
      used: 1,
      remaining: 2,
      reason: 'native_decision',
      stage: 'match',
      observationStableCount: 2
    });
  });

  test('formats compare summary through native owner', () => {
    expect(formatStopMessageCompareContextWithNative({
      ...BASE_CONTEXT,
      armed: false,
      mode: 'off',
      allowModeOnly: true,
      active: false,
      stopEligible: false,
      hasCapturedRequest: false,
      compactionRequest: true,
      hasSeed: false,
      decision: 'skip',
      reason: 'skip_reached_max_repeats',
      observationHash: 'abc',
      toolSignatureHash: 'sig'
    })).toBe(
      'decision=skip reason=skip_reached_max_repeats armed=false mode=off allowModeOnly=true max=3 used=1 left=2 active=false stopEligible=false compaction=true seed=false obs=abc stable=n/a toolSig=sig'
    );
  });

  test('attach writes normalized MetadataCenter runtime_control context', () => {
    const adapterContext: Record<string, unknown> = {};
    MetadataCenter.attach(adapterContext);
    attachStopMessageCompareContext(adapterContext, {
      ...BASE_CONTEXT,
      textLength: 11.9,
      maxRepeats: 2.7,
      used: 1.1,
      remaining: 1.8,
      stage: ' entry '
    } as StopMessageCompareContext);

    expect(readStopMessageCompareContext(adapterContext)).toEqual({
      ...NORMALIZED_BASE_CONTEXT,
      textLength: 11,
      maxRepeats: 2,
      used: 1,
      remaining: 1,
      stage: 'entry'
    });
  });

  test('attach preserves request-local MetadataCenter binding on metadata side-channel', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    const adapterContext: Record<string, unknown> = { metadata };

    attachStopMessageCompareContext(adapterContext, BASE_CONTEXT);

    expect(MetadataCenter.read(adapterContext.metadata as Record<string, unknown>)).toBe(center);
  });


  test('attach preserves observation hash, stable count, and tool signature for no-change loop tracking', () => {
    const adapterContext: Record<string, unknown> = {};
    MetadataCenter.attach(adapterContext);
    attachStopMessageCompareContext(adapterContext, {
      ...BASE_CONTEXT,
      observationHash: 'same-observation',
      observationStableCount: 3.9,
      toolSignatureHash: 'tool-signature'
    } as StopMessageCompareContext);

    expect(readStopMessageCompareContext(adapterContext)).toEqual({
      ...NORMALIZED_BASE_CONTEXT,
      observationHash: 'same-observation',
      observationStableCount: 3,
      toolSignatureHash: 'tool-signature'
    });
  });

  test('missing MetadataCenter fails instead of writing legacy runtime metadata', () => {
    expect(() => attachStopMessageCompareContext({}, BASE_CONTEXT)).toThrow(
      'MetadataCenter runtime_control.stopMessageCompareContext writer requires a bound MetadataCenter'
    );
  });

  test('invalid adapter context fails instead of swallowing metadata write errors', () => {
    expect(() => attachStopMessageCompareContext(null, BASE_CONTEXT)).toThrow(
      'MetadataCenter runtime_control.stopMessageCompareContext writer requires object carrier'
    );
  });

  test('invalid metadata context is absent and formats as no context', () => {
    const invalid = readStopMessageCompareContext(makeAdapterWithCompareContext({
      decision: 'maybe',
      reason: 'bad'
    }));

    expect(invalid).toBeUndefined();
    expect(formatStopMessageCompareContextWithNative(invalid)).toBe('decision=unknown reason=no_context');
  });
});
