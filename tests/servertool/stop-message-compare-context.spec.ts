import { describe, expect, test } from '@jest/globals';

import {
  attachStopMessageCompareContext,
  formatStopMessageCompareContext,
  readStopMessageCompareContext,
  type StopMessageCompareContext
} from '../../sharedmodule/llmswitch-core/src/servertool/stop-message-compare-context.js';
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

describe('servertool stop-message compare context', () => {
  test('reads metadata context through native normalization', () => {
    const context = readStopMessageCompareContext({
      __rt: {
        stopMessageCompareContext: {
          ...BASE_CONTEXT,
          mode: ' ON ',
          textLength: 12.9,
          maxRepeats: 3.8,
          used: 1.2,
          decision: ' TRIGGER ',
          reason: ' native_decision ',
          stage: ' match ',
          observationStableCount: 2.7
        }
      }
    });

    expect(context).toEqual({
      ...BASE_CONTEXT,
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
    expect(formatStopMessageCompareContext({
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
      'decision=skip reason=skip_reached_max_repeats armed=false mode=off allowModeOnly=true max=3 used=1 left=2 active=false stopEligible=false captured=false compaction=true seed=false obs=abc stable=n/a toolSig=sig'
    );
  });

  test('attach writes normalized runtime metadata context', () => {
    const adapterContext: Record<string, unknown> = {};
    attachStopMessageCompareContext(adapterContext, {
      ...BASE_CONTEXT,
      textLength: 11.9,
      maxRepeats: 2.7,
      used: 1.1,
      remaining: 1.8,
      stage: ' entry '
    } as StopMessageCompareContext);

    expect(readStopMessageCompareContext(adapterContext)).toEqual({
      ...BASE_CONTEXT,
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
    attachStopMessageCompareContext(adapterContext, {
      ...BASE_CONTEXT,
      observationHash: 'same-observation',
      observationStableCount: 3.9,
      toolSignatureHash: 'tool-signature'
    } as StopMessageCompareContext);

    expect(readStopMessageCompareContext(adapterContext)).toEqual({
      ...BASE_CONTEXT,
      observationHash: 'same-observation',
      observationStableCount: 3,
      toolSignatureHash: 'tool-signature'
    });
  });

  test('invalid adapter context fails instead of swallowing metadata write errors', () => {
    expect(() => attachStopMessageCompareContext(null, BASE_CONTEXT)).toThrow(
      'ensureRuntimeMetadata requires object carrier'
    );
  });

  test('invalid metadata context is absent and formats as no context', () => {
    const invalid = readStopMessageCompareContext({
      __rt: {
        stopMessageCompareContext: {
          decision: 'maybe',
          reason: 'bad'
        }
      }
    });

    expect(invalid).toBeUndefined();
    expect(formatStopMessageCompareContext(invalid)).toBe('decision=unknown reason=no_context');
  });
});
