#!/usr/bin/env node
// V3 architecture CI umbrella.
// Composes the V3-specific architecture gates that must run together
// as a single architecture CI entry, so .github/workflows and local
// `make verify`/release/install preconditions share the same source of truth.
//
// Sub-gate ordering: cheap pure checks first; doc/resource maps second;
// type/module/call-map third; closeout gates last. Failures short-circuit.
//
// If a sub-gate needs Jason manual authorization (e.g. lock fingerprint
// drift), it returns non-zero with a deterministic reason; this wrapper
// surfaces the reason verbatim and fails the umbrella without skipping.

import { spawnSync } from 'node:child_process';

const STEPS = [
  ['verify:agent-p0-payload-control-guard', 'Agent and RouteCodex skill entry surfaces expose the P0 payload/control isolation guard before routing'],
  ['test:agent-p0-payload-control-guard-red-fixtures', 'P0 payload/control entry guard mutations are rejected'],
  ['verify:v3-rust-only', 'V3 crates must be Rust-only (no JS/TS in v3/)'],
  ['verify:v3-build-test-artifact-budget', 'V3 Cargo tests release owned artifacts and enforce the 2 GiB debug budget'],
  ['test:v3-build-test-artifact-budget-red-fixtures', 'V3 build artifact budget mutations are rejected'],
  ['verify:v3-file-size', 'V3 file-size ratchet (<=1500 or approved whitelist)'],
  ['verify:v3-resource-map', 'V3 resource-operation-map parseable + bound'],
  ['verify:v3-resource-relation-edge-lock', 'V3 resource relation edge lock'],
  ['verify:v3-provider-action-gate', 'Provider failures enter typed Error05 action policy'],
  ['verify:v3-provider-session-cooldown', 'Provider failure cooldown and recovery are session-isolated'],
  ['test:v3-provider-session-cooldown-red-fixtures', 'Session cooldown architecture mutations are rejected'],
  ['test:v3-provider-session-cooldown', 'Session cooldown and cross-session revive behavior'],
  ['test:v3-p5-router-target', 'Priority-first and same-priority weighted Router/Target selection'],
  ['verify:v3-module-boundaries', 'V3 module boundaries (Server cannot build/classify Error)'],
  ['verify:sse-architecture-boundary', 'SSE runtime dispatch remains Rust-owned'],
  ['verify:error-pipeline-contract', 'Provider failures use the shared typed error pipeline'],
  [
    'verify:provider-response-errorerr-bypass-closeout',
    'Provider response hosts cannot bypass typed Error policy',
  ],
  ['verify:v3-hub-v1-node-file-topology', 'Hub v1 node file topology symbols resolve'],
  ['verify:v3-mainline-caller-flow', 'V3 mainline caller flow + lock fingerprint'],
  ['verify:v3-static-hook-registry', 'V3 static hook registry (no provider-specific / non-adjacent / H1 network)'],
  ['verify:v3-entry-protocol-endpoint-binding', 'V3 entry protocol/endpoint binding'],
  ['verify:v3-stage-protocol-shapes', 'Direct same-protocol and Relay per-stage protocol shape contract'],
  ['test:v3-stage-protocol-shapes-red-fixtures', 'Stage-shape contract mutations are rejected'],
  ['verify:responses-continuation-immutable-boundary', 'Responses continuation save-to-restore interval remains semantically immutable'],
  ['test:responses-continuation-immutable-boundary-red-fixtures', 'Continuation immutable-boundary mutations are rejected'],
  ['verify:v3-responses-direct-remote-continuation', 'Responses remote continuation identity and provider-bound lifecycle remain locked'],
  ['test:v3-responses-direct-remote-continuation-red-fixtures', 'Remote continuation identity and SSE closeout mutations are rejected'],
  ['verify:v3-relay-tool-servertool-multiturn-parity-closeout', 'Req04/Resp03 tool governance preserves restored history and current-turn ownership'],
  ['test:v3-relay-tool-servertool-multiturn-parity-closeout-red-fixtures', 'Historical payload rewrite and wrong-owner tool mutations are rejected'],
  ['verify:v3-selected-provider-model-binding', 'V3 selected provider/model binding'],
  ['verify:v3-protocol-conversion-field-parity', 'V3 protocol conversion field parity'],
  ['verify:v3-stopless-resource-control', 'V3 stopless resource control'],
  ['verify:v3-server-tool-center-audit', 'V3 servertool center writes carry written_by/reason/request_id audit'],
  ['verify:v3-stopless-state-machine-docs', 'V3 stopless state machine docs'],
  ['verify:v3-normalization-payload-logic-boundary', 'V3 normalization payload/logic boundary'],
  ['verify:v3-hub-relay-runtime-closeout', 'V3 hub relay runtime closeout'],
  ['verify:v3-architecture-docs', 'V3 architecture docs umbrella'],
  ['verify:v3-hub-pipeline-core-manifests', 'V3 hub pipeline core manifests'],
];

const failures = [];
const passThrough = [];
for (const [script, description] of STEPS) {
  const r = spawnSync('npm', ['run', '--silent', script], { encoding: 'utf8', cwd: process.cwd() });
  const stdout = (r.stdout || '').trim();
  const stderr = (r.stderr || '').trim();
  const ok = r.status === 0;
  const banner = ok ? 'PASS' : 'FAIL';
  process.stdout.write(`[verify:v3-architecture-ci] ${banner} ${script} - ${description}\n`);
  if (!ok) {
    failures.push({ script, description, code: r.status, stdout, stderr });
    process.stdout.write(`${stdout}\n${stderr}\n`);
    break; // short-circuit on first failure
  } else if (stdout) {
    process.stdout.write(`${stdout}\n`);
    passThrough.push(script);
  }
}

if (failures.length > 0) {
  process.stdout.write(`\n[verify:v3-architecture-ci] FAILED at ${failures[0].script} (${failures.length} sub-failure total in run)\n`);
  process.stdout.write(`[verify:v3-architecture-ci] passed before failure: ${passThrough.length}/${STEPS.length}\n`);
  process.exit(1);
}

process.stdout.write(`\n[verify:v3-architecture-ci] ok (${passThrough.length}/${STEPS.length} sub-gates green)\n`);
