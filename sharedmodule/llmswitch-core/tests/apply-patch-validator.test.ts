import { describe, expect, test } from '@jest/globals';

import { validateToolCall } from '../src/tools/tool-registry.js';
import os from 'node:os';
import path from 'node:path';

describe('apply_patch validator (shape fixes)', () => {
  test('accepts raw patch text and wraps into JSON patch/input', () => {
    const raw = `*** Begin Patch
*** Add File: a.txt
+hello
*** End Patch`;

    const res = validateToolCall('apply_patch', raw);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Begin Patch');
    expect(normalized.patch).toContain('*** End Patch');
    expect(normalized.input).toContain('*** Begin Patch');
  });

  test('accepts JSON payload with patch + input (idempotent)', () => {
    const patch = `*** Begin Patch
*** Update File: a.txt
@@
 hello
*** End Patch`;
    const args = JSON.stringify({ patch, input: patch });

    const res = validateToolCall('apply_patch', args);
    expect(res.ok).toBe(true);
    expect(typeof res.normalizedArgs).toBe('string');
  });

  test('coerces instructions field containing JSON changes array (missing_changes fix)', () => {
    const changes = [{ kind: 'create_file', lines: 'one\ntwo' }];
    const args = JSON.stringify({
      file: 'a.txt',
      instructions: JSON.stringify(changes)
    });

    const res = validateToolCall('apply_patch', args);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Add File: a.txt');
  });

  test('applies create_file + insert_after edits to created content (change_sequence fix)', () => {
    const args = JSON.stringify({
      file: 'a.txt',
      changes: [
        { kind: 'create_file', lines: 'hello\nworld' },
        { kind: 'insert_after', anchor: 'hello', lines: 'X' }
      ]
    });

    const res = validateToolCall('apply_patch', args);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Add File: a.txt');
    expect(normalized.patch).toContain('+hello');
    expect(normalized.patch).toContain('+X');
    expect(normalized.patch).toContain('+world');
  });

  test('repairs arg_key artifacts in JSON keys', () => {
    const args = `{
      \"<arg_key>file</arg_key>\": \"a.txt\",
      \"changes\": [
        { \"kind\": \"create_file\", \"lines\": \"ok\" }
      ]
    }`;

    const res = validateToolCall('apply_patch', args);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Add File: a.txt');
  });

  test('converts unified diff (GNU patch) update into apply_patch format', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      'index 1111111..2222222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,2 @@',
      '-foo',
      '+bar',
      ' baz',
      ''
    ].join('\n');

    const res = validateToolCall('apply_patch', diff);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Begin Patch');
    expect(normalized.patch).toContain('*** Update File: a.txt');
    expect(normalized.patch).toContain('@@ -1,2 +1,2 @@');
    expect(normalized.patch).toContain('-foo');
    expect(normalized.patch).toContain('+bar');
    expect(normalized.patch).toContain('*** End Patch');
  });

  test('converts unified diff (GNU patch) add/delete (via /dev/null) into apply_patch format', () => {
    const addDiff = [
      'diff --git a/new.txt b/new.txt',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      ''
    ].join('\n');
    const addRes = validateToolCall('apply_patch', addDiff);
    expect(addRes.ok).toBe(true);
    const addNormalized = JSON.parse(addRes.normalizedArgs as string);
    expect(addNormalized.patch).toContain('*** Add File: new.txt');
    expect(addNormalized.patch).toContain('+hello');
    expect(addNormalized.patch).toContain('+world');

    const delDiff = [
      'diff --git a/old.txt b/old.txt',
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-bye',
      ''
    ].join('\n');
    const delRes = validateToolCall('apply_patch', delDiff);
    expect(delRes.ok).toBe(true);
    const delNormalized = JSON.parse(delRes.normalizedArgs as string);
    expect(delNormalized.patch).toContain('*** Delete File: old.txt');
    expect(delNormalized.patch).toContain('*** Begin Patch');
    expect(delNormalized.patch).toContain('*** End Patch');
  });

  test('converts unified diff (GNU patch) rename-only into move-only apply_patch format', () => {
    const renameDiff = [
      'diff --git a/oldname.txt b/newname.txt',
      'similarity index 100%',
      'rename from oldname.txt',
      'rename to newname.txt',
      ''
    ].join('\n');

    const res = validateToolCall('apply_patch', renameDiff);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Begin Patch');
    expect(normalized.patch).toContain('*** Update File: oldname.txt');
    expect(normalized.patch).toContain('*** Move to: newname.txt');
    expect(normalized.patch).toContain('*** End Patch');
  });

  test('normalizes malformed unified markers (++++ / @@@@) from errorsamples', () => {
    const malformedAddDiff = [
      '*** Begin Patch',
      '--- /dev/null',
      '++++ DELIVERY.md',
      '@@@@',
      '+## delivery',
      '+- item',
      '*** End Patch'
    ].join('\n');

    const res = validateToolCall('apply_patch', JSON.stringify({ input: malformedAddDiff }));
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Begin Patch');
    expect(normalized.patch).toContain('*** Add File: DELIVERY.md');
    expect(normalized.patch).toContain('+## delivery');
    expect(normalized.patch).toContain('*** End Patch');
  });

  test('rejects code snippets that merely mention patch markers', () => {
    const snippet = [
      '    fn test_normalize_tool_args_variants() {',
      '        assert!(normalized.contains(\"*** Begin Patch\"));',
      '        assert!(normalized.contains(\"*** End Patch\"));',
      '    }'
    ].join('\n');

    const res = validateToolCall('apply_patch', snippet);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('missing_changes');
    expect(res.message).toBe('结构完整但无内容');
  });

  test('converts star-header unified diff into apply_patch format', () => {
    const diff = [
      '*** lib/utils/network/bandwidth_tier_strategy.dart',
      '--- lib/utils/network/bandwidth_tier_strategy.dart',
      '@@ -71,7 +71,7 @@',
      '     this.stepDownMinLossFraction = 0.03,',
      '-    this.minVideoBitrateKbps = 25,',
      '+    this.minVideoBitrateKbps = 15,',
      '     this.maxQualityBoostKbps = 1500,',
      '   });'
    ].join('\n');

    const res = validateToolCall('apply_patch', JSON.stringify({ patch: diff }));
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Begin Patch');
    expect(normalized.patch).toContain('*** Update File: lib/utils/network/bandwidth_tier_strategy.dart');
    expect(normalized.patch).toContain('*** End Patch');
  });

  test('converts escaped-newline star-header unified diff into apply_patch format', () => {
    const diffEscaped =
      '*** lib/utils/network/bandwidth_tier_strategy.dart\\n--- lib/utils/network/bandwidth_tier_strategy.dart\\n@@ -71,7 +71,7 @@\\n     this.stepDownMinLossFraction = 0.03,\\n-    this.minVideoBitrateKbps = 25,\\n+    this.minVideoBitrateKbps = 15,\\n     this.maxQualityBoostKbps = 1500,\\n   });';

    const res = validateToolCall('apply_patch', JSON.stringify({ patch: diffEscaped }));
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Begin Patch');
    expect(normalized.patch).toContain('*** Update File: lib/utils/network/bandwidth_tier_strategy.dart');
    expect(normalized.patch).toContain('*** End Patch');
  });

  test('normalizes Begin Patch payload that only has legacy --- a/file header', () => {
    const patch = [
      '*** Begin Patch',
      '--- a/apps/mobile-app/src/services/mobileWebdavSync.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '*** End Patch'
    ].join('\n');

    const res = validateToolCall('apply_patch', patch);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Update File: apps/mobile-app/src/services/mobileWebdavSync.ts');
    expect(normalized.patch).not.toContain('--- a/apps/mobile-app/src/services/mobileWebdavSync.ts');
    expect(normalized.patch).toContain('@@ -1 +1 @@');
  });

  test('normalizes create file header with trailing stars and missing line prefixes', () => {
    const patch = [
      '*** Create File: /tmp/analyze_cov.py ***',
      '#!/usr/bin/env python3',
      'import sys'
    ].join('\n');

    const res = validateToolCall('apply_patch', JSON.stringify({ patch }));
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Begin Patch');
    expect(normalized.patch).toContain('*** Add File: /tmp/analyze_cov.py');
    expect(normalized.patch).toContain('+#!/usr/bin/env python3');
    expect(normalized.patch).toContain('+import sys');
    expect(normalized.patch).toContain('*** End Patch');
  });

  test('strips wrapping quotes from apply_patch file headers', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: "src/quoted.ts"',
      '+console.log("ok");',
      '*** End Patch'
    ].join('\n');

    const res = validateToolCall('apply_patch', patch);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Add File: src/quoted.ts');
    expect(normalized.patch).not.toContain('*** Add File: "src/quoted.ts"');
  });

  test('normalizes home path aliases in apply_patch file headers', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: /Volumes/extension/code/finger/~/.codex/config.toml',
      '@@',
      '-old = true',
      '+old = false',
      '*** End Patch'
    ].join('\n');

    const res = validateToolCall('apply_patch', patch);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    const expected = path.join(os.homedir(), '.codex', 'config.toml');
    expect(normalized.patch).toContain(`*** Update File: ${expected}`);
    expect(normalized.patch).not.toContain('/~/');
  });

  test('normalizes single-line begin-patch create-file header into add-file patch', () => {
    const patch =
      "*** Begin Patch *** Create File: src/orchestration/quota/types.ts\n/**\n * Quota Types\n */\n*** End Patch";

    const res = validateToolCall('apply_patch', patch);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Begin Patch');
    expect(normalized.patch).toContain('*** Add File: src/orchestration/quota/types.ts');
    expect(normalized.patch).toContain('+/**');
    expect(normalized.patch).toContain('+ * Quota Types');
    expect(normalized.patch).toContain('+ */');
    expect(normalized.patch).toContain('*** End Patch');
  });

  test('treats top-level target as file alias when changes exist', () => {
    const args = JSON.stringify({
      target: 'scripts/xiaohongshu/tests/phase1-4-full-collect.mjs',
      changes: [
        {
          kind: 'replace',
          target: 'const oldLine = 1;',
          lines: 'const newLine = 1;'
        }
      ]
    });

    const res = validateToolCall('apply_patch', args);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Update File: scripts/xiaohongshu/tests/phase1-4-full-collect.mjs');
  });

  test('coerces conflict-marker payload with top-level path into replace patch', () => {
    const args = JSON.stringify({
      path: 'src/providers/core/runtime/gemini-cli-http-provider.ts',
      patch: [
        '<<<<<<< ORIGINAL',
        "console.log('old')",
        '=======',
        "console.log('new')",
        '>>>>>>> UPDATED'
      ].join('\n')
    });

    const res = validateToolCall('apply_patch', args);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Update File: src/providers/core/runtime/gemini-cli-http-provider.ts');
    expect(normalized.patch).toContain("-console.log('old')");
    expect(normalized.patch).toContain("+console.log('new')");
  });

  test('extracts patch from nested command envelope string (errorsample missing_changes)', () => {
    const commandEnvelope = [
      '["apply_patch", "*** Begin Patch\\n*** Add File: nested-command.txt\\n+hello\\n*** End Patch\\n"]]'
    ].join('');

    const args = JSON.stringify({
      command: commandEnvelope
    });

    const res = validateToolCall('apply_patch', args);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Add File: nested-command.txt');
    expect(normalized.patch).toContain('*** Begin Patch');
    expect(normalized.patch).toContain('*** End Patch');
  });
});
