import { describe, expect, test } from '@jest/globals';
import * as fs from 'node:fs';

import {
  formatStopMessageCompareContextWithNative,
  normalizeStopMessageCompareContextWithNative
} from '../../src/modules/llmswitch/bridge/native-exports.js';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.ts';

type StopMessageCompareContext = Record<string, unknown>;

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

function readStopMessageCompareContext(adapterContext: unknown): unknown {
  const target = adapterContext && typeof adapterContext === 'object'
    ? adapterContext as Record<string, unknown>
    : undefined;
  const center = target ? MetadataCenter.read(target) : undefined;
  return normalizeStopMessageCompareContextWithNative(
    center?.readRuntimeControl().stopMessageCompareContext
  );
}

describe('servertool stop-message compare context', () => {
  test('servertool metadata carrier shell stays physically deleted', () => {
    expect(fs.existsSync('sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.ts')).toBe(false);
  });

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
    const center = MetadataCenter.attach(adapterContext);
    const normalized = normalizeStopMessageCompareContextWithNative({
      ...BASE_CONTEXT,
      textLength: 11.9,
      maxRepeats: 2.7,
      used: 1.1,
      remaining: 1.8,
      stage: ' entry '
    });
    center.writeRuntimeControl(
      'stopMessageCompareContext',
      normalized as Record<string, unknown>,
      TEST_WRITER,
      'stop-message compare control signal'
    );

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
    const normalized = normalizeStopMessageCompareContextWithNative(BASE_CONTEXT);
    center.writeRuntimeControl(
      'stopMessageCompareContext',
      normalized as Record<string, unknown>,
      TEST_WRITER,
      'stop-message compare control signal'
    );

    expect(MetadataCenter.read(adapterContext.metadata as Record<string, unknown>)).toBe(center);
  });


  test('attach preserves observation hash, stable count, and tool signature for no-change loop tracking', () => {
    const adapterContext: Record<string, unknown> = {};
    const center = MetadataCenter.attach(adapterContext);
    const normalized = normalizeStopMessageCompareContextWithNative({
      ...BASE_CONTEXT,
      observationHash: 'same-observation',
      observationStableCount: 3.9,
      toolSignatureHash: 'tool-signature'
    });
    center.writeRuntimeControl(
      'stopMessageCompareContext',
      normalized as Record<string, unknown>,
      TEST_WRITER,
      'stop-message compare control signal'
    );

    expect(readStopMessageCompareContext(adapterContext)).toEqual({
      ...NORMALIZED_BASE_CONTEXT,
      observationHash: 'same-observation',
      observationStableCount: 3,
      toolSignatureHash: 'tool-signature'
    });
  });

  test('invalid metadata context is absent and formats as no context', () => {
    const invalid = readStopMessageCompareContext(makeAdapterWithCompareContext({
      decision: 'maybe',
      reason: 'bad'
    }));

    expect(invalid).toBeNull();
    expect(formatStopMessageCompareContextWithNative(invalid)).toBe('decision=unknown reason=no_context');
  });
});
