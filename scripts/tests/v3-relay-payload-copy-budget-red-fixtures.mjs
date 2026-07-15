#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(repoRoot, 'scripts/architecture/verify-v3-relay-payload-copy-budget.mjs');
const fixtures = [
  {
    name: 'unbounded deep copy',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'use serde_json::Value;',
    mutation: 'use serde_json::Value;\nfn forbidden_copy(payload: &Value) { payload.deep_clone(); }',
    diagnostic: /forbidden unbounded deep copy/,
  },
  {
    name: 'JSON stringify parse roundtrip',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'use serde_json::Value;',
    mutation: 'use serde_json::Value;\nfn forbidden_roundtrip(payload: &Value) { let encoded = serde_json::to_string(payload).unwrap(); let _: Value = serde_json::from_str(&encoded).unwrap(); }',
    diagnostic: /forbidden JSON serialization round-trip clone/,
  },
  {
    name: 'full SSE materialize',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
    marker: 'use serde_json::Value;',
    mutation: 'use serde_json::Value;\nfn forbidden_sse_materialize(sse_stream: impl Iterator<Item = Value>) { let _ = sse_stream.collect::<Vec<_>>(); }',
    diagnostic: /forbidden full SSE materialization/,
  },
  {
    name: 'Debug snapshot truth substitution',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'use serde_json::Value;',
    mutation: 'use serde_json::Value;\nfn forbidden_snapshot(debug_snapshot: &Value) { let continuation_truth_payload = debug_snapshot; let _ = continuation_truth_payload; }',
    diagnostic: /forbidden Debug\/snapshot truth substitution/,
  },
  {
    name: 'hook plan retained payload',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resource_hooks.rs',
    marker: 'use std::',
    mutation: 'struct HookPlan { retained_payload: serde_json::Value }\nuse std::',
    diagnostic: /forbidden hook planning payload retention or clone/,
  },
  {
    name: 'canonical payload sharing assertion removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
    marker: 'Arc::ptr_eq(&context.payload, &self.previous.previous.previous.payload.0)',
    mutation: 'true',
    diagnostic: /missing Arc::ptr_eq/,
  },
  {
    name: 'Req04 restore ownership removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'Ok(Some(Arc::clone(&local.canonical_context)))',
    mutation: 'Ok(None)',
    diagnostic: /missing Ok\(Some\(Arc::clone/,
  },
];

const failures = [];
for (const fixture of fixtures) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-relay-copy-red-'));
  try {
    for (const relative of ['v3', 'docs', 'scripts', 'package.json']) {
      cpSync(resolve(repoRoot, relative), join(root, relative), {
        recursive: true,
        filter: (source) => !source.includes('/target/'),
      });
    }
    const target = join(root, fixture.file);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(fixture.marker)) {
      failures.push(`${fixture.name}: mutation marker missing`);
      continue;
    }
    writeFileSync(target, source.replace(fixture.marker, fixture.mutation));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${fixture.name}: verifier unexpectedly passed`);
    else if (!fixture.diagnostic.test(output)) {
      failures.push(`${fixture.name}: wrong diagnostic: ${output.slice(-700)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error('[test:v3-relay-payload-copy-budget-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[test:v3-relay-payload-copy-budget-red-fixtures] ok (${fixtures.length} forbidden mutations rejected)`);
