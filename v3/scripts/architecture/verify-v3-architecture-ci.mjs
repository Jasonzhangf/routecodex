#!/usr/bin/env node
// V3 architecture CI umbrella.
// Composes the V3-specific architecture gates that must run together
// as a single architecture CI entry, so .github/workflows and local
// `make verify`/release/install preconditions share the same source of truth.
//
// Sub-gate ordering: cheap pure checks first; doc/resource maps second;
// type/module/call-map third; closeout gates last. Each listed gate is an
// independent sibling; nested npm scripts retain any prerequisite semantics.
//
// If a sub-gate needs Jason manual authorization (e.g. lock fingerprint
// drift), it returns non-zero with a deterministic reason; this wrapper
// surfaces the reason verbatim and fails the umbrella without skipping.

import { spawnSync } from 'node:child_process';

const STEPS = [
  ['test:v3-architecture-ci-failure-aggregation-regression', 'V3 architecture CI reports all independent sibling failures'],
  ['verify:v3-direct-sse-accept-skeleton', 'Direct SSE client accept/worker skeleton remains frozen'],
  ['verify:v3-direct-sse-full-attempt-commit', 'Direct SSE provider attempts remain fully buffered until terminal success'],
  ['verify:v3-contract-map-owner', 'V3 contract-map owner and lifecycle bindings remain synchronized'],
  ['verify:v3-mainline-manifest-sync', 'Generated architecture manifests remain bound to canonical call maps'],
  ['verify:v3-rust-only', 'V3 runtime crates must be Rust-only'],
  ['verify:v3-rust-only-server-entry', 'Legacy TypeScript server entries remain physically retired'],
  ['verify:v3-build-test-artifact-budget', 'V3 Cargo tests release owned artifacts and enforce the 2 GiB debug budget'],
  ['verify:v3-file-size', 'V3 file-size ratchet (<=1500 or approved whitelist)'],
  ['verify:v3-resource-map', 'V3 resource-operation-map parseable + bound'],
  ['verify:v3-provider-key-health-model-binding', 'Provider key health model identity source binding'],
  ['verify:v3-provider-session-cooldown', 'Provider failure cooldown and recovery are session-isolated'],
  ['test:v3-provider-session-cooldown', 'Session cooldown and cross-session revive behavior'],
  ['test:v3-p5-router-target', 'Priority-first and same-priority weighted Router/Target selection'],
  ['verify:v3-module-boundaries', 'V3 module boundaries (Server cannot build/classify Error)'],
  ['test:v3-compile-fail', 'V3 private and non-adjacent type boundaries remain compiler-enforced'],
  ['verify:v3-hub-v1-node-file-topology', 'Hub v1 node file topology symbols resolve'],
  ['verify:v3-static-hook-registry', 'V3 static hook registry (no provider-specific / non-adjacent / H1 network)'],
  ['verify:v3-entry-protocol-endpoint-binding', 'V3 entry protocol/endpoint binding'],
  ['verify:v3-stage-protocol-shapes', 'Direct same-protocol and Relay per-stage protocol shape contract'],
  ['verify:v3-relay-tool-servertool-multiturn-parity-closeout', 'Req04/Resp03 tool governance preserves restored history and current-turn ownership'],
  ['verify:v3-protocol-conversion-field-parity-ci', 'V3 protocol conversion parity aggregate gate'],
  ['verify:v3-server-tool-center-audit', 'V3 servertool center writes carry written_by/reason/request_id audit'],
  ['verify:v3-hub-relay-runtime-closeout', 'V3 hub relay runtime closeout'],
  ['verify:v3-architecture-docs', 'V3 architecture docs umbrella'],
  ['verify:v3-hub-pipeline-core-manifests', 'V3 hub pipeline core manifests'],
];

const failures = [];
const passedSteps = [];
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
  } else {
    passedSteps.push(script);
    if (stdout) process.stdout.write(`${stdout}\n`);
  }
}

if (failures.length > 0) {
  process.stdout.write(`\n[verify:v3-architecture-ci] FAILED at ${failures[0].script} (${failures.length} sub-failure total in run)\n`);
  process.stdout.write(`[verify:v3-architecture-ci] failed sub-gates: ${failures.map(({ script }) => script).join(', ')}\n`);
  process.stdout.write(`[verify:v3-architecture-ci] passed sub-gates: ${passedSteps.length}/${STEPS.length}\n`);
  process.exit(1);
}

process.stdout.write(`\n[verify:v3-architecture-ci] ok (${passedSteps.length}/${STEPS.length} sub-gates green)\n`);
