#!/usr/bin/env node

import assert from 'node:assert/strict';
import { normalizeApplyPatchArgs } from '../../dist/tools/apply-patch/args-normalizer/index.js';

function ensureOk(result, message) {
  assert.equal(result.ok, true, message);
}

async function main() {
  const starHeaderPayload = {
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
  };

  const argsString = JSON.stringify(starHeaderPayload);
  const defaultResult = normalizeApplyPatchArgs(argsString, starHeaderPayload);
  ensureOk(defaultResult, 'default action pipeline should normalize patch payload');
  assert.ok(defaultResult.patchText.includes('*** Begin Patch'));

  const disabledResult = normalizeApplyPatchArgs(argsString, starHeaderPayload, {
    actions: [{ action: 'raw_non_json_patch' }]
  });
  assert.equal(disabledResult.ok, false, 'custom actions should disable record extraction');
  if (!disabledResult.ok) {
    assert.equal(disabledResult.reason, 'missing_changes');
  }

  const enabledResult = normalizeApplyPatchArgs(argsString, starHeaderPayload, {
    actions: [{ action: 'record_text_fields', fields: ['patch'] }]
  });
  ensureOk(enabledResult, 'custom actions should enable record patch extraction');
  assert.ok(enabledResult.patchText.includes('*** Update File: lib/utils/network/bandwidth_tier_strategy.dart'));

  console.log('[matrix:apply-patch-action-pipeline] ok');
}

main().catch((error) => {
  console.error('[matrix:apply-patch-action-pipeline] failed', error);
  process.exit(1);
});
