#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const { convertContextDiffToApplyPatch } = await import('../../dist/tools/apply-patch/patch-text/context-diff.js');

  // 1) no file headers → null
  {
    const out = convertContextDiffToApplyPatch('not a diff');
    assert.equal(out, null);
  }

  // 2) minimal single-file hunk
  {
    const diff = [
      '*** foo.txt',
      '--- foo.txt',
      '***************',
      '*** 1 ****',
      '-old line',
      '--- 1 ----',
      '+new line',
      ''
    ].join('\n');
    const out = convertContextDiffToApplyPatch(diff);
    assert.ok(out && out.includes('*** Begin Patch'));
    assert.ok(out && out.includes('*** Update File: foo.txt'));
    assert.ok(out && out.includes('-old line'));
    assert.ok(out && out.includes('+new line'));
    assert.ok(out && out.includes('*** End Patch'));
  }

  // 3) replacement marker "!" in new-half should become add
  {
    const diff = [
      '*** bar.txt',
      '--- bar.txt',
      '***************',
      '*** 1 ****',
      '!old',
      '--- 1 ----',
      '!new',
      ''
    ].join('\n');
    const out = convertContextDiffToApplyPatch(diff);
    assert.ok(out && out.includes('-old'), 'old-half "!" treated as delete');
    assert.ok(out && out.includes('+new'), 'new-half "!" treated as add');
  }

  console.log('✅ coverage-context-diff passed');
}

main().catch((e) => {
  console.error('❌ coverage-context-diff failed:', e);
  process.exit(1);
});

