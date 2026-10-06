import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve('scripts/architecture/verify-no-fallback-diff.mjs');
const sourceConfig = readFileSync('docs/architecture/no-fallback-diff-rules.json', 'utf8');
const modulePath = 'v3/crates/routecodex-v3-lifecycle/src/hooks_sidecar/tests.rs';
const ownerPath = 'v3/crates/routecodex-v3-lifecycle/src/hooks_sidecar.rs';

test('all-files no-fallback gate excludes the cfg(test) hooks module and still rejects product code', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rcc-no-fallback-source-'));
  const write = (file, text) => {
    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  };
  const run = () => spawnSync(process.execPath, [script, '--all'], { cwd: root, encoding: 'utf8' });
  try {
    write('docs/architecture/no-fallback-diff-rules.json', sourceConfig);
    write(modulePath, 'assert!(detail.is_some(), "degraded detail must name the unavailable capability");\n');
    write(ownerPath, '#[cfg(test)]\nmod tests;\nfn production() {}\n');
    const testOnly = run();
    assert.equal(testOnly.status, 0, testOnly.stderr);

    write(ownerPath, 'fn production() {\n    fallback();\n}\n');
    const productFallback = run();
    assert.equal(productFallback.status, 1, productFallback.stdout);
    assert.match(productFallback.stderr, /hooks_sidecar\.rs:2 \[fallback-keyword\]/);

    write(ownerPath, 'fn production() {\n    record("degraded output");\n}\n');
    const productDegraded = run();
    assert.equal(productDegraded.status, 1, productDegraded.stdout);
    assert.match(productDegraded.stderr, /hooks_sidecar\.rs:2 \[degrade-keyword\]/);

    write(ownerPath, 'fn production() {}\n');
    write('v3/crates/routecodex-v3-lifecycle/src/hooks_sidecar/real_transport.rs', 'fn production() {\n    fallback();\n}\n');
    const neighboringProduct = run();
    assert.equal(neighboringProduct.status, 1, neighboringProduct.stdout);
    assert.match(neighboringProduct.stderr, /real_transport\.rs:2 \[fallback-keyword\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
});
