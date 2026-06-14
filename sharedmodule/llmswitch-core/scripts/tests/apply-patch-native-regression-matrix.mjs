#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  normalizeApplyPatchArgumentsWithNative,
  validateApplyPatchArgumentsWithNative
} from '../../dist/native/router-hotpath/native-chat-process-governance-semantics.js';

function parseNormalizedArgs(result) {
  assert.equal(typeof result?.normalizedArguments, 'string', 'normalizedArguments must be string');
  return JSON.parse(result.normalizedArguments);
}

async function main() {
  const cwd = process.cwd();
  const tmpDir = path.join(cwd, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const relPath = `tmp/apply-patch-matrix-${process.pid}.txt`;
  const absPath = path.join(cwd, relPath);
  fs.writeFileSync(absPath, 'alpha\nbeta\ngamma\n');

  try {
    // 1) absolute path
    {
      const result = validateApplyPatchArgumentsWithNative({
        patch: `*** Begin Patch\n*** Update File: ${absPath}\n@@\n-beta\n+beta2\n*** End Patch`
      });
      assert.equal(result.ok, true, 'absolute path should validate');
      const parsed = parseNormalizedArgs(result);
      assert.equal(parsed.patch.includes(absPath), false, 'absolute path must be relativized');
      assert.ok(parsed.patch.includes(`*** Update File: ${relPath}`), 'relative path must be preserved');
    }

    // 2) line-number-only hunk
    {
      const result = validateApplyPatchArgumentsWithNative({
        patch: `*** Begin Patch\n*** Update File: ${relPath}\n@@ -20,1 +20,1 @@\n-beta\n+beta2\n*** End Patch`
      });
      assert.equal(result.ok, true, 'line-number-only hunk should validate');
      const parsed = parseNormalizedArgs(result);
      assert.equal(parsed.patch.includes('@@ -20,1 +20,1 @@'), false, 'line-number hunk header must be removed');
      assert.ok(parsed.patch.includes('@@\n alpha\n-beta\n+beta2\n gamma'), 'live context must be injected for executable canonical hunk');
    }

    // 3) mixed internal + GNU should be normalized into canonical apply_patch
    {
      const result = validateApplyPatchArgumentsWithNative({
        patch: '*** Begin Patch\n--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old\n+new\n*** End Patch'
      });
      assert.equal(result.ok, true, 'mixed internal + GNU should normalize through the native verdict');
      const parsed = parseNormalizedArgs(result);
      assert.ok(parsed.patch.includes('*** Begin Patch'));
      assert.ok(parsed.patch.includes('*** Update File: demo.txt'));
      assert.ok(parsed.patch.includes('@@\n-old\n+new'));
      assert.equal(parsed.input, undefined);
    }

    // 4) raw / wrapped / json envelope
    {
      const patch = '*** Begin Patch\n*** Add File: demo.txt\n+hi\n*** End Patch';
      const raw = normalizeApplyPatchArgumentsWithNative(patch);
      const wrapped = normalizeApplyPatchArgumentsWithNative({ input: patch });
      const jsonEnvelope = normalizeApplyPatchArgumentsWithNative({ patch });
      for (const [label, result] of [
        ['raw', raw],
        ['wrapped', wrapped],
        ['json', jsonEnvelope]
      ]) {
        const parsed = parseNormalizedArgs(result);
        assert.equal(parsed.patch, patch, `${label} patch must normalize to canonical patch field`);
        assert.equal(parsed.input, undefined, `${label} input alias must not leak back into canonical args`);
      }
    }

    // 4.1) shell-wrapped apply_patch heredoc must be harvested by explicit apply_patch tool shape
    {
      const shellWrapped = `bash -lc "echo hi && apply_patch <<'PATCH'
*** Begin Patch
*** Add File: src/nope.ts
+console.log('nope');
*** End Patch
PATCH"`;
      const result = normalizeApplyPatchArgumentsWithNative(shellWrapped);
      const parsed = parseNormalizedArgs(result);
      assert.ok(parsed.patch.includes('*** Begin Patch'), 'shell-wrapped apply_patch must preserve canonical patch');
      assert.ok(parsed.patch.includes('*** Add File: src/nope.ts'), 'shell-wrapped apply_patch must preserve target file');
      assert.ok(parsed.patch.includes("+console.log('nope');"), 'shell-wrapped apply_patch must preserve add-file content');
      assert.equal(parsed.input, undefined, 'shell-wrapped apply_patch input alias must not leak back into canonical args');
    }

    // 4.2) hashline shape missing fileContent must fail-fast instead of silently normalizing to empty patch
    {
      const result = validateApplyPatchArgumentsWithNative({
        patch: '+ 2 deadbeef\nhello',
        filePath: 'note.txt'
      });
      assert.equal(result.ok, false, 'hashline missing fileContent must stay invalid');
      assert.equal(result.reason, 'hashline_missing_file_content');
    }

    // 5) add-file without leading + should be repaired by native verdict
    {
      const result = validateApplyPatchArgumentsWithNative({
        patch: '*** Begin Patch\n*** Add File: demo.txt\nhello\n*** End Patch'
      });
      assert.equal(result.ok, true, 'add-file without + should be repaired');
      const parsed = parseNormalizedArgs(result);
      assert.equal(
        parsed.patch,
        '*** Begin Patch\n*** Add File: demo.txt\n+hello\n*** End Patch',
        'native verdict must plus-prefix add-file content'
      );
      assert.equal(parsed.input, undefined);
    }

    // 6) GNU line-number hunk with inline context trailer must collapse to canonical @@ hunk
    {
      const result = validateApplyPatchArgumentsWithNative({
        patch: `*** Begin Patch\n*** Update File: ${absPath}\n@@ -1,2 +1,3 @@ alpha\n beta\n+beta2\n gamma\n*** End Patch`
      });
      assert.equal(result.ok, true, 'line-number hunk with inline context trailer should validate');
      const parsed = parseNormalizedArgs(result);
      assert.equal(parsed.patch.includes('@@ -1,2 +1,3 @@'), false, 'GNU line-number hunk header must be removed');
      assert.ok(parsed.patch.includes('@@\n alpha\n beta\n+beta2\n gamma'), 'inline context trailer must become canonical apply_patch context');
    }

    console.log('✅ apply_patch native regression matrix passed');
  } finally {
    fs.rmSync(absPath, { force: true });
  }
}

main().catch((error) => {
  console.error('[matrix:apply-patch-native-regression-matrix] failed', error);
  process.exit(1);
});
