#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(repoRoot, 'scripts/architecture/verify-v3-local-continuation-contract-store.mjs');
const sourceFile = 'v3/crates/routecodex-v3-runtime/src/local_continuation.rs';
const fixtures = [
  ['Resp04 save moved to Resp05', 'commit_at_resp04', 'commit_at_resp05', /missing commit_at_resp04|wrong save or restore boundary/],
  ['Req04 restore moved to Req03', 'restore_at_req04', 'restore_at_req03', /missing restore_at_req04|wrong save or restore boundary/],
  ['unknown-field lock removed', '#[serde(deny_unknown_fields)]', '#[serde(default)]', /must both deny unknown fields/],
  ['Debug snapshot truth added', 'use serde_json::Value;', 'use serde_json::Value;\nconst debug_snapshot: &str = "truth";', /forbidden Debug or snapshot truth/],
  ['provider pin inference added', 'use serde_json::Value;', 'use serde_json::Value;\nconst provider_id: &str = "guessed";', /forbidden provider pin inference/],
  ['fallback path added', 'use serde_json::Value;', 'use serde_json::Value;\nfn fallback_to_remote() {}', /forbidden fallback/],
  ['cross-owner guard removed', 'if request.owner != V3LocalContinuationRestoreOwner::RouteCodexLocal', 'if false', /missing explicit cross-owner restore rejection/],
  ['lossless decoder replaced', 'serde_json::from_slice(encoded)', 'serde_json::from_value(serde_json::json!({}))', /missing serde_json::from_slice|forbidden semantic JSON value rebuild/],
];

const failures = [];
for (const [name, marker, replacement, diagnostic] of fixtures) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-local-cont-red-'));
  try {
    for (const relative of ['v3', 'docs', 'scripts']) {
      cpSync(resolve(repoRoot, relative), join(root, relative), {
        recursive: true,
        filter: (source) => !source.includes('/target/'),
      });
    }
    const target = join(root, sourceFile);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(marker)) {
      failures.push(`${name}: mutation marker missing`);
      continue;
    }
    writeFileSync(target, source.replace(marker, replacement));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${name}: verifier unexpectedly passed`);
    else if (!diagnostic.test(output)) failures.push(`${name}: wrong diagnostic: ${output.slice(-700)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error('[test:v3-local-continuation-contract-store-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[test:v3-local-continuation-contract-store-red-fixtures] ok (${fixtures.length} forbidden mutations rejected)`);
