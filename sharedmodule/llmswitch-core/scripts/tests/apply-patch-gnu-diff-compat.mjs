#!/usr/bin/env node

import assert from 'node:assert/strict';

import { validateToolCall } from '../../dist/tools/tool-registry.js';

function mustOk(label, args) {
  const res = validateToolCall('apply_patch', args);
  assert.equal(res?.ok, true, `${label}: expected ok=true, got ok=${String(res?.ok)} reason=${String(res?.reason)}`);
  assert.equal(typeof res.normalizedArgs, 'string', `${label}: expected normalizedArgs string`);
  const parsed = JSON.parse(res.normalizedArgs);
  assert.equal(typeof parsed.patch, 'string', `${label}: normalizedArgs.patch must be string`);
  assert.equal(typeof parsed.input, 'string', `${label}: normalizedArgs.input must be string`);
  assert.ok(parsed.patch.includes('*** Begin Patch'), `${label}: patch must include Begin Patch`);
  assert.ok(parsed.patch.includes('*** End Patch'), `${label}: patch must include End Patch`);
  return parsed.patch;
}

function main() {
  // 1) update diff (diff --git)
  {
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
    const patch = mustOk('gnu_diff:update', diff);
    assert.ok(patch.includes('*** Update File: a.txt'), 'gnu_diff:update must target a.txt');
    assert.ok(patch.includes('@@ -1,2 +1,2 @@'), 'gnu_diff:update must preserve @@ hunk header');
    assert.ok(patch.includes('-foo'), 'gnu_diff:update must preserve - line');
    assert.ok(patch.includes('+bar'), 'gnu_diff:update must preserve + line');
  }

  // 2) add via /dev/null (no diff --git header)
  {
    const addDiff = [
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      ''
    ].join('\n');
    const patch = mustOk('gnu_diff:add', addDiff);
    assert.ok(patch.includes('*** Add File: new.txt'), 'gnu_diff:add must be Add File new.txt');
    assert.ok(patch.includes('+hello'), 'gnu_diff:add must include +hello');
    assert.ok(patch.includes('+world'), 'gnu_diff:add must include +world');
  }

  // 3) delete via /dev/null (no diff --git header)
  {
    const delDiff = [
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-bye',
      ''
    ].join('\n');
    const patch = mustOk('gnu_diff:delete', delDiff);
    assert.ok(patch.includes('*** Delete File: old.txt'), 'gnu_diff:delete must be Delete File old.txt');
  }

  // 4) rename (diff --git + rename from/to)
  {
    const renameDiff = [
      'diff --git a/oldname.txt b/newname.txt',
      'similarity index 100%',
      'rename from oldname.txt',
      'rename to newname.txt',
      ''
    ].join('\n');
    const patch = mustOk('gnu_diff:rename', renameDiff);
    assert.ok(patch.includes('*** Update File: oldname.txt'), 'gnu_diff:rename must update old path');
    assert.ok(patch.includes('*** Move to: newname.txt'), 'gnu_diff:rename must include Move to');
  }

  console.log('✅ apply_patch GNU unified diff compatibility passed');
}

main();

