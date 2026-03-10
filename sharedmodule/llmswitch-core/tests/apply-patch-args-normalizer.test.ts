import { describe, expect, test } from '@jest/globals';

import { normalizeApplyPatchArgs } from '../src/tools/apply-patch/args-normalizer/index.js';

describe('apply_patch args normalizer action pipeline', () => {
  test('default actions normalize star-header diff payload', () => {
    const argsString = JSON.stringify({
      patch: [
        '*** lib/utils/network/bandwidth_tier_strategy.dart',
        '--- lib/utils/network/bandwidth_tier_strategy.dart',
        '@@ -71,7 +71,7 @@',
        '     this.stepDownMinLossFraction = 0.03,',
        '-    this.minVideoBitrateKbps = 25,',
        '+    this.minVideoBitrateKbps = 15,',
        '     this.maxQualityBoostKbps = 1500,',
        '   });'
      ].join('\n')
    });

    const rawArgs = JSON.parse(argsString);
    const result = normalizeApplyPatchArgs(argsString, rawArgs);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patchText).toContain('*** Begin Patch');
      expect(result.patchText).toContain('*** Update File: lib/utils/network/bandwidth_tier_strategy.dart');
      expect(result.patchText).toContain('*** End Patch');
    }
  });

  test('custom actions can disable record extraction', () => {
    const argsString = JSON.stringify({
      patch: '*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch'
    });
    const rawArgs = JSON.parse(argsString);

    const result = normalizeApplyPatchArgs(argsString, rawArgs, {
      actions: [{ action: 'raw_non_json_patch' }]
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_changes');
    }
  });

  test('custom actions can explicitly allow patch field extraction', () => {
    const argsString = JSON.stringify({
      patch: '*** Begin Patch\n*** Add File: b.txt\n+y\n*** End Patch'
    });
    const rawArgs = JSON.parse(argsString);

    const result = normalizeApplyPatchArgs(argsString, rawArgs, {
      actions: [{ action: 'record_text_fields', fields: ['patch'] }]
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patchText).toContain('*** Add File: b.txt');
    }
  });

  test('default actions extract patch from command envelope field', () => {
    const commandEnvelope = '["apply_patch", "*** Begin Patch\\n*** Add File: cmd-envelope.txt\\n+ok\\n*** End Patch\\n"]]';
    const argsString = JSON.stringify({ command: commandEnvelope });
    const rawArgs = JSON.parse(argsString);

    const result = normalizeApplyPatchArgs(argsString, rawArgs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patchText).toContain('*** Add File: cmd-envelope.txt');
      expect(result.patchText).toContain('*** Begin Patch');
      expect(result.patchText).toContain('*** End Patch');
    }
  });
});
