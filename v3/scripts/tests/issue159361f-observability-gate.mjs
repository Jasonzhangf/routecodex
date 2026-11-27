#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../..', import.meta.url));
const tests = [
  ['routecodex-v3-provider-responses', '--test', 'general_provider', 'sse_request_accepts_json_provider_response_as_json_raw_body'],
  ['routecodex-v3-provider-responses', '--test', 'general_provider', 'json_request_accepts_sse_provider_response_as_sse_raw_body'],
  ['routecodex-v3-runtime', '--lib', 'direct_responses_'],
  ['routecodex-v3-runtime', '--lib', 'generic_provider_observation_keeps_completed_absence_without_direct_owner'],
  ['routecodex-v3-runtime', '--test', 'hub_relay_runtime_closeout', 'responses_relay_sse_completed_without_provider_finish_reason_keeps_absence'],
  ['routecodex-v3-server', '--lib', 'direct_frame_console_'],
  ['routecodex-v3-server', '--lib', 'direct_sse_console_'],
  ['routecodex-v3-server', '--lib', 'direct_stream_request_error06_retains_diagnostics_without_wire_event'],
];
for (const [crate, ...selector] of tests) {
  const args = ['scripts/run-v3-cargo-test.mjs', '-p', crate, ...selector, '--', '--nocapture'];
  console.log(JSON.stringify({ command: process.execPath, args }));
  const result = spawnSync(process.execPath, args, { cwd, env: { ...process.env, CARGO_NET_OFFLINE: 'true' }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error || result.status !== 0 || !/test result: ok\. [1-9]\d* passed/.test(result.stdout ?? '')) process.exit(result.status || 1);
}
