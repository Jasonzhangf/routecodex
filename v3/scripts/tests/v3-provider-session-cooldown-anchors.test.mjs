import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const v3 = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repo = resolve(v3, '..');
const verifier = join(v3, 'scripts/architecture/verify-v3-provider-session-cooldown.mjs');
const streamPath = 'v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs';
const signatureDiagnostic = 'Direct SSE projection must receive the original typed failure session scope';
const bindingDiagnostic = 'Direct SSE projection must retain the original typed failure session scope';

function run(root) {
  const result = spawnSync(process.execPath, [verifier], {
    cwd: root,
    env: { ...process.env, V3_PROVIDER_SESSION_COOLDOWN_ROOT: root },
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.ok(result.status === 0 || result.status === 1);
  return `${result.stdout}\n${result.stderr}`;
}

test('Direct SSE gate follows the current owner and detects both scope mutations', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'v3-cooldown-anchors-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['v3/crates', 'docs/architecture', 'package.json']) {
    cpSync(join(repo, path), join(root, path), { recursive: true });
  }
  const target = join(root, streamPath);
  const original = readFileSync(target, 'utf8');
  const baseline = run(root);
  const kernel = join(root, 'v3/crates/routecodex-v3-runtime/src/kernel.rs');
  const kernelOriginal = readFileSync(kernel, 'utf8');
  const scopeDiagnostic = 'Direct runtime must not derive provider failure scope from continuation state';

  await t.test('continuation neighbours do not invalidate the original typed scope', () => {
    assert.ok(!baseline.includes(scopeDiagnostic));
  });

  await t.test('reconstructing scope from continuation is rejected', () => {
    const mutated = kernelOriginal.replace(
      'let direct_failure_session_scope = standardized.failure_session_scope.clone();',
      'let direct_failure_session_scope = V3ProviderFailureSessionScope::new(&standardized.server_id, &continuation_scope.key.routing_group, &continuation_scope.key.session_id).unwrap();',
    );
    assert.notEqual(mutated, kernelOriginal);
    writeFileSync(kernel, mutated);
    try {
      assert.ok(run(root).includes(scopeDiagnostic));
    } finally {
      writeFileSync(kernel, kernelOriginal);
    }
  });

  await t.test('current owner has no missing-path or Direct SSE scope failures', () => {
    assert.doesNotMatch(baseline, /missing required source:.*direct_sse_provider_outcome/);
    assert.doesNotMatch(baseline, /missing Direct SSE/);
    assert.ok(!baseline.includes(signatureDiagnostic));
    assert.ok(!baseline.includes(bindingDiagnostic));
  });

  for (const mutation of [
    {
      name: 'missing typed parameter is rejected',
      before: '    failure_session_scope: &V3ProviderFailureSessionScope,',
      after: '    failure_session_scope_removed: &V3ProviderFailureSessionScope,',
      diagnostic: signatureDiagnostic,
    },
    {
      name: 'lost scope forwarding is rejected',
      before: 'Some(failure_session_scope.session_id().to_owned()),',
      after: 'None,',
      diagnostic: bindingDiagnostic,
    },
  ]) {
    await t.test(mutation.name, () => {
      assert.ok(!baseline.includes(mutation.diagnostic), 'diagnostic must be introduced by the mutation');
      const mutated = original.replace(mutation.before, mutation.after);
      assert.notEqual(mutated, original);
      writeFileSync(target, mutated);
      try {
        assert.ok(run(root).includes(mutation.diagnostic));
      } finally {
        writeFileSync(target, original);
      }
    });
  }
});
