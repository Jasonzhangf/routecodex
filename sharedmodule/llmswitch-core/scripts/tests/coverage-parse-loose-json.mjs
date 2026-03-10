#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const { tryParseJson, tryParseJsonLoose } = await import('../../dist/tools/apply-patch/json/parse-loose.js');

  // tryParseJson: rejects non-strings / empties / non-container prefixes
  assert.equal(tryParseJson(null), undefined);
  assert.equal(tryParseJson(''), undefined);
  assert.equal(tryParseJson('not json'), undefined);

  // tryParseJson: accepts valid containers
  assert.deepEqual(tryParseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(tryParseJson('[1,2]'), [1, 2]);

  // tryParseJsonLoose: repairs unescaped quotes inside strings (common in JSX snippets)
  {
    const broken = '{"code":"className="foo"","ok":true}';
    const repaired = tryParseJsonLoose(broken);
    assert.ok(repaired && typeof repaired === 'object');
    assert.equal(repaired.ok, true);
  }

  // tryParseJsonLoose: balances mismatched containers outside strings
  {
    const broken = '{"a":[1,2}';
    const repaired = tryParseJsonLoose(broken);
    assert.ok(repaired && typeof repaired === 'object');
    assert.deepEqual(repaired.a, [1, 2]);
  }

  // tryParseJsonLoose: returns undefined when no progress is possible
  assert.deepEqual(tryParseJsonLoose('{"a":1}'), { a: 1 });
  assert.equal(tryParseJsonLoose('{a:1}'), undefined);

  console.log('✅ coverage-parse-loose-json passed');
}

main().catch((e) => {
  console.error('❌ coverage-parse-loose-json failed:', e);
  process.exit(1);
});
