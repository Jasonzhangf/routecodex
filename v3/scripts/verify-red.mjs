#!/usr/bin/env node
import { runAll } from './_common.mjs';

const entries = [
  {
    label: 'independent-build-isolation-red-fixtures',
    command: 'node',
    args: ['tests/scripts/v3-independent-build-isolation-red-fixtures.mjs'],
    severity: 'BLOCK',
  },
  {
    label: 'aggregate-environment-availability-regression',
    command: 'node',
    args: ['scripts/tests/v3-aggregate-environment-availability-regression.mjs'],
    severity: 'BLOCK',
  },
  {
    label: 'architecture-admission-red-fixtures',
    command: 'node',
    args: ['tests/scripts/v3-architecture-admission-red-fixtures.mjs'],
    severity: 'BLOCK',
  },
  {
    label: 'build-test-artifact-budget-red-fixtures',
    command: 'node',
    args: ['tests/scripts/v3-build-test-artifact-budget-red-fixtures.mjs'],
    severity: 'BLOCK',
  },
  ...[
  'scripts/tests/v3-anthropic-codec-characterization-red-fixtures.mjs',
  'scripts/tests/v3-anthropic-relay-controlled-replay-harness-red-fixtures.mjs',
  'scripts/tests/v3-anthropic-relay-local-continuation-red-fixtures.mjs',
  'scripts/tests/v3-anthropic-relay-protocol-hooks-red-fixtures.mjs',
  'scripts/tests/v3-anthropic-relay-runtime-integration-red-fixtures.mjs',
  'scripts/tests/v3-console-request-count-visibility-red-fixtures.mjs',
  'scripts/tests/v3-debug-payload-budget-red-fixtures.mjs',
  'scripts/tests/v3-entry-protocol-endpoint-binding-red-fixtures.mjs',
  'scripts/tests/v3-file-size-red-fixtures.mjs',
  'scripts/tests/v3-gemini-codec-characterization-red-fixtures.mjs',
  'scripts/tests/v3-gemini-relay-runtime-integration-red-fixtures.mjs',
  'scripts/tests/v3-h1-source-red-fixtures.mjs',
  'scripts/tests/v3-h2-equivalence-red-fixtures.mjs',
  'scripts/tests/v3-hub-pipeline-core-manifest-red-fixtures.mjs',
  'scripts/tests/v3-hub-relay-runtime-closeout-red-fixtures.mjs',
  'scripts/tests/v3-hub-skeleton-doc-red-fixtures.mjs',
  'scripts/tests/v3-hub-v1-node-file-topology-red-fixtures.mjs',
  'scripts/tests/v3-live-provider-compat-parity-red-fixtures.mjs',
  'scripts/tests/v3-local-continuation-contract-store-red-fixtures.mjs',
  'scripts/tests/v3-mainline-caller-flow-red-fixtures.mjs',
  'scripts/tests/v3-managed-server-lifecycle-red-fixtures.mjs',
  'scripts/tests/v3-normalization-payload-logic-boundary-red-fixtures.mjs',
  'scripts/tests/v3-openai-chat-codec-characterization-red-fixtures.mjs',
  'scripts/tests/v3-openai-chat-relay-runtime-integration-red-fixtures.mjs',
  'scripts/tests/v3-p6-freeze-red-fixtures.mjs',
  'scripts/tests/v3-protocol-conversion-field-parity-red-fixtures.mjs',
  'scripts/tests/v3-provider-action-gate-red-fixtures.mjs',
  'scripts/tests/v3-provider-directory-config-red-fixtures.mjs',
  'scripts/tests/v3-provider-session-cooldown-red-fixtures.mjs',
  'scripts/tests/v3-relay-hook-resource-red-fixtures.mjs',
  'scripts/tests/v3-relay-payload-copy-budget-red-fixtures.mjs',
  'scripts/tests/v3-relay-request-semantics-red-fixtures.mjs',
  'scripts/tests/v3-relay-response-semantics-red-fixtures.mjs',
  'scripts/tests/v3-relay-tool-servertool-multiturn-parity-red-fixtures.mjs',
  'scripts/tests/v3-resource-relation-edge-lock-red-fixtures.mjs',
  'scripts/tests/v3-responses-direct-remote-continuation-red-fixtures.mjs',
  'scripts/tests/v3-responses-inbound-websocket-proxy-red-fixtures.mjs',
  'scripts/tests/v3-responses-session-admission-red-fixtures.mjs',
  'scripts/tests/v3-responses-websocket-v2-transport-hardening-red-fixtures.mjs',
  'scripts/tests/v3-selected-provider-model-binding-red-fixtures.mjs',
  'scripts/tests/v3-servertool-center-skeleton-red-fixtures.mjs',
  'scripts/tests/v3-source-gate-red-fixtures.mjs',
  'scripts/tests/v3-stage-protocol-shapes-red-fixtures.mjs',
].map((fixture) => ({
    label: fixture,
    command: 'node',
    args: ['scripts/run-admission-gate.mjs', fixture],
    severity: 'BLOCK',
  })),
];

const { failures, warnings } = await runAll(entries);
if (warnings.length > 0) {
  process.stderr.write(`[v3 verify:red] WARN ${warnings.length} gate(s)\n`);
  for (const warning of warnings) process.stderr.write(`- ${warning}\n`);
}
if (failures.length > 0) {
  process.stderr.write(`[v3 verify:red] FAIL ${failures.length} gate(s)\n`);
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('[v3 verify:red] PASS\n');
}
