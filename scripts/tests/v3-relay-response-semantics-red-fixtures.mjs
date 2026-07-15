#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(repoRoot, 'scripts/architecture/verify-v3-relay-response-semantics.mjs');
const fixtures = [
  ['Resp05 continuation save', 'V3HubRespOutbound05ClientSemantic { previous: input }', 'V3HubRespOutbound05ClientSemantic { previous: input, canonical_context: Some(input) }', /Resp05\/Server immutable interval/],
  ['SSE semantic repair', 'V3ServerRespOutbound06ClientFrame { previous: input }', 'V3ServerRespOutbound06ClientFrame { previous: input }; serde_json::to_string(&"repair").unwrap()', /Resp05\/Server immutable interval/],
  ['handler continuation save', 'use routecodex_v3_runtime', 'use routecodex_v3_runtime; fn save() { compile_v3_hub_relay_response_hooks(); }', /semantics escaped Hub/],
  ['required_action outbound inference', 'V3HubRespOutbound05ClientSemantic { previous: input }', 'if required_action { unreachable!() } V3HubRespOutbound05ClientSemantic { previous: input }', /Resp05\/Server immutable interval/],
  ['second response exit', '"V3ServerRespOutbound06ClientFrame"', '"V3ServerRespOutbound06AlternateFrame"', /missing "V3ServerRespOutbound06ClientFrame"|single response exit/],
  ['Resp03 continuation save', 'let object = input', 'let canonical_context = Some(input.previous.payload.clone());\n    let object = input', /Resp03 Chat Process/],
  ['missing status fallback', '.ok_or(V3HubRelayResponseError::MissingStatus)?', '.unwrap_or("completed")', /Resp03 Chat Process/],
  ['full response clone', 'payload: Arc::clone(&input.previous.previous.payload.0)', 'payload: input.previous.previous.payload.0.as_ref().clone().into()', /missing Arc::clone|exactly one Arc::clone/],
];

const failures = [];
for (const [name, from, to, diagnostic] of fixtures) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-relay-response-red-'));
  try {
    cpSync(resolve(repoRoot, 'v3/crates/routecodex-v3-runtime/src'), join(root, 'v3/crates/routecodex-v3-runtime/src'), { recursive: true });
    cpSync(resolve(repoRoot, 'v3/crates/routecodex-v3-server/src'), join(root, 'v3/crates/routecodex-v3-server/src'), { recursive: true });
    cpSync(resolve(repoRoot, 'v3/crates/routecodex-v3-provider-responses/src'), join(root, 'v3/crates/routecodex-v3-provider-responses/src'), { recursive: true });
    const relative = name === 'handler continuation save'
      ? 'v3/crates/routecodex-v3-server/src/lib.rs'
      : 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs';
    const target = join(root, relative);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(from)) throw new Error(`${name}: fixture source missing`);
    writeFileSync(target, source.replace(from, to));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${name}: gate unexpectedly passed`);
    else if (!diagnostic.test(output)) failures.push(`${name}: wrong diagnostic: ${output.slice(-600)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-relay-response-semantics-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-relay-response-semantics-red-fixtures] ok (${fixtures.length} forbidden mutations rejected)`);
