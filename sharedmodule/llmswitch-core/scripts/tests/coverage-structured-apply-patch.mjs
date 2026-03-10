#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const { buildStructuredPatch, StructuredApplyPatchError } = await import('../../dist/tools/apply-patch/structured.js');

  // create_file + insert_after + replace + delete + delete_file
  {
    const payload = {
      file: 'a.txt',
      changes: [
        { kind: 'create_file', lines: ['Line 1', 'Line 2'] },
        { kind: 'insert_after', anchor: 'Line 1', lines: 'Inserted' },
        { kind: 'replace', target: 'Line 2', lines: ['Line 2 replaced'] },
        { kind: 'delete', target: 'Inserted' },
        { kind: 'delete_file', file: 'obsolete.txt' }
      ]
    };

    const patch = buildStructuredPatch(payload);
    assert.ok(patch.includes('*** Begin Patch'));
    assert.ok(patch.includes('*** Add File: a.txt'));
    assert.ok(patch.includes('+Line 1'));
    assert.ok(patch.includes('+Line 2 replaced'));
    assert.ok(patch.includes('*** Delete File: obsolete.txt'));
    assert.ok(patch.includes('*** End Patch'));
  }

  // multi-file update section: insert_before using explicit file on change
  {
    const payload = {
      changes: [
        { kind: 'create_file', file: 'b.txt', lines: 'A\nB' },
        { kind: 'insert_before', file: 'b.txt', anchor: 'A', lines: 'X', use_anchor_indent: true }
      ]
    };
    const patch = buildStructuredPatch(payload);
    assert.ok(patch.includes('*** Add File: b.txt'));
  }

  // error: missing changes
  {
    assert.throws(
      () => buildStructuredPatch({ changes: [] }),
      (e) => e instanceof StructuredApplyPatchError && e.reason === 'missing_changes'
    );
  }

  // error: unknown kind
  {
    assert.throws(
      () => buildStructuredPatch({ changes: [{ kind: 'wat' }] }),
      (e) => e instanceof StructuredApplyPatchError
    );
  }

  console.log('✅ coverage-structured-apply-patch passed');
}

main().catch((e) => {
  console.error('❌ coverage-structured-apply-patch failed:', e);
  process.exit(1);
});

