#!/usr/bin/env node
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-responses-websocket-v2-transport-hardening.mjs');
const transport = 'v3/crates/routecodex-v3-provider-responses/src/transport.rs';
const tests = 'v3/crates/routecodex-v3-provider-responses/tests/responses_websocket_v2.rs';
const server = 'v3/crates/routecodex-v3-server/src/lib.rs';
const copied = [
  transport,
  tests,
  server,
  'v3/crates/routecodex-v3-runtime/src/kernel.rs',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'package.json',
];
const cases = [
  ['early drop keeps socket', transport, '*self.connection = None;', '// mutated: keep socket', /connection/],
  ['JSON missing type keeps socket', transport, 'None => {\n                    *connection = None;\n                    return Err(websocket_protocol_error(', 'None => {\n                    return Err(websocket_protocol_error(', /connection/],
  ['WebSocket event accumulation', transport, 'async fn send_websocket_v2(', 'fn forbidden() { let mut response_events = Vec::new(); response_events.push(1); }\n    async fn send_websocket_v2(', /Vec/],
  ['HTTP retry fallback', transport, 'async fn send_websocket_v2(', 'fn fallback_http_retry() {}\n    async fn send_websocket_v2(', /fallback/i],
  ['Server socket owner', server, 'pub struct V3ServerAggregateHandle {', 'struct SharedResponsesWebSocket;\npub struct V3ServerAggregateHandle {', /socket owner|SharedResponsesWebSocket/],
  ['concurrency case removed', tests, 'websocket_v2_concurrent_streams_are_serialized_without_cross_frame_leakage', 'websocket_v2_concurrency_case_removed', /concurrent/],
];

const failures = [];
for (const [name, relative, from, to, diagnostic] of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-ws2-hardening-red-'));
  try {
    for (const path of copied) {
      const destination = resolve(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(resolve(repo, path), destination);
    }
    const target = resolve(root, relative);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(from)) throw new Error(`${name}: mutation source missing`);
    writeFileSync(target, source.replace(from, to));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${name}: verifier unexpectedly passed`);
    else if (!diagnostic.test(output)) failures.push(`${name}: wrong diagnostic: ${output.slice(-500)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-responses-websocket-v2-transport-hardening-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-responses-websocket-v2-transport-hardening-red-fixtures] ok (${cases.length} forbidden mutations rejected)`);
