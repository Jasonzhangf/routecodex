#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  runRegisteredGates,
  validateEvidenceRef,
} from '../architecture/lib/feature-layer-batch-evidence.mjs';
import { validateRegistryBindings } from '../architecture/lib/feature-layer-batch-registry.mjs';
import { loadCanonicalInput } from '../architecture/verify-v4-feature-layer-batches.mjs';

const now = Date.now();
const candidate = {
  head_commit: '0123456789abcdef0123456789abcdef01234567',
  scope_hash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  blobs: [{
    path: 'scripts/architecture/verify-v4-feature-layer-batches.mjs',
    sha256: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  }],
};
const gate = {
  status: 'active',
  evidence_role: 'positive',
  argv: ['node', 'scripts/architecture/verify-v4-feature-layer-batches.mjs', '--self-test'],
  producer: { adapter: 'node', identity: 'v4_feature_layer_batches_self_test' },
};
const ref = {
  role: 'positive',
  gate_id: 'v4_feature_layer_batches_self_test',
  path: 'docs/evidence/feature-completion/M1/V4-GATE-001/positive.json',
};
const baseEvidence = {
  evidence_id: 'positive',
  issue_id: 'V4-GATE-001',
  experiment_id: 'v4-feature-layer-gate',
  phase: 'positive_intervention',
  kind: 'positive_test',
  source_commit: candidate.head_commit,
  scope: { feature_id: 'V4-GATE-001', module_id: 'routecodex-v4-governance' },
  producer: gate.producer,
  command_argv: gate.argv,
  result: 'pass',
  created_at: new Date(now - 1_000).toISOString(),
  expires_at: new Date(now + 86_400_000).toISOString(),
  input_hashes: [candidate.blobs[0].sha256],
  scope_hash: candidate.scope_hash,
  exit_status: 0,
};
const context = {
  trackedAt: () => true,
  ignored: () => false,
  blobIdentity: () => candidate.blobs[0],
};
const shared = {
  ref,
  expectedRole: 'positive',
  expectedFeatureId: 'V4-GATE-001',
  expectedModuleIds: ['routecodex-v4-governance'],
  expectedGateId: ref.gate_id,
  candidate,
  sourcePaths: [candidate.blobs[0].path],
  gateMap: new Map([[ref.gate_id, gate]]),
  truth: context,
  integrationCommit: candidate.head_commit,
  now,
};

const validFailures = [];
validateEvidenceRef({ ...shared, evidence: baseEvidence, failures: validFailures });
assert.equal(validFailures.length, 0, JSON.stringify(validFailures));

const mismatchFailures = [];
validateEvidenceRef({
  ...shared,
  evidence: {
    ...baseEvidence,
    producer: { adapter: 'node', identity: 'v4_feature_layer_batches' },
    command_argv: ['node', 'scripts/architecture/verify-v4-feature-layer-batches.mjs'],
  },
  failures: mismatchFailures,
});
assert(
  mismatchFailures.some((failure) => failure.code === 'EVIDENCE_PRODUCER_MISMATCH'),
  'a shared-lane projection must not satisfy the self-test evidence gate',
);

const sharedRuntimeCandidate = {
  head_commit: candidate.head_commit,
  scope_hash: candidate.scope_hash,
  blobs: [
    ...candidate.blobs,
    {
      path: 'crates/routecodex-v4-runtime/Cargo.toml',
      sha256: 'sha256:123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd',
    },
  ],
};
const sharedRuntimeGate = {
  status: 'active',
  evidence_role: 'positive',
  argv: ['node', 'scripts/architecture/verify-v4-runtime.mjs', '--request-port'],
  producer: { adapter: 'node', identity: 'v4_runtime_005_request_port_positive' },
};
const sharedRuntimeRef = {
  role: 'positive',
  gate_id: 'v4_runtime_005_request_port_positive',
  path: 'docs/evidence/feature-completion/M2/V4-RUNTIME-005/positive.json',
};
const incompleteSharedRuntimeFailures = [];
validateEvidenceRef({
  ref: sharedRuntimeRef,
  expectedRole: 'positive',
  expectedFeatureId: 'V4-RUNTIME-005',
  expectedModuleIds: ['routecodex-v4-runtime'],
  expectedGateId: sharedRuntimeRef.gate_id,
  candidate: sharedRuntimeCandidate,
  sourcePaths: [candidate.blobs[0].path],
  gateInputPaths: [sharedRuntimeCandidate.blobs[1].path],
  gateMap: new Map([[sharedRuntimeRef.gate_id, sharedRuntimeGate]]),
  truth: {
    ...context,
    blobIdentity(_commit, sourcePath) {
      return sharedRuntimeCandidate.blobs.find((blob) => blob.path === sourcePath);
    },
  },
  integrationCommit: sharedRuntimeCandidate.head_commit,
  now,
  evidence: {
    ...baseEvidence,
    evidence_id: 'positive',
    issue_id: 'V4-RUNTIME-005',
    scope: { feature_id: 'V4-RUNTIME-005', module_id: 'routecodex-v4-runtime' },
    producer: sharedRuntimeGate.producer,
    command_argv: sharedRuntimeGate.argv,
    input_hashes: [sharedRuntimeCandidate.blobs[0].sha256],
  },
  failures: incompleteSharedRuntimeFailures,
});
assert(
  incompleteSharedRuntimeFailures.some((failure) => failure.code === 'EVIDENCE_INPUT_HASH_MISMATCH'),
  'shared runtime evidence must bind every declared input hash',
);

const sharedArgv = ['cargo', 'test', '-p', 'fixture'];
const distinctArgv = ['node', 'fixture/gate.mjs'];
const gateMap = new Map([
  ['fixture_positive', { status: 'active', argv: sharedArgv }],
  ['fixture_red', { status: 'active', argv: [...sharedArgv] }],
  ['fixture_boundary', { status: 'active', argv: distinctArgv }],
]);
const executed = [];
const gateFailures = [];
runRegisteredGates({
  gateIds: ['fixture_positive', 'fixture_red', 'fixture_boundary'],
  gateMap,
  truth: {
    runGate(argv) {
      executed.push(argv);
      return { status: 0 };
    },
  },
  failures: gateFailures,
  context: 'regression',
});
assert.deepEqual(executed, [sharedArgv, distinctArgv], 'identical gate argv must execute once');
assert.equal(gateFailures.length, 0, JSON.stringify(gateFailures));

const failedExecutions = [];
const failedGateFailures = [];
runRegisteredGates({
  gateIds: ['fixture_positive', 'fixture_red'],
  gateMap,
  truth: {
    runGate(argv) {
      failedExecutions.push(argv);
      return { status: 17 };
    },
  },
  failures: failedGateFailures,
  context: 'regression',
});
assert.equal(failedExecutions.length, 1, 'a failed identical gate must not be rerun');
assert.deepEqual(failedGateFailures.map((failure) => failure.message), [
  'regression: fixture_positive exited 17',
  'regression: fixture_red exited 17',
]);

const zeroMatchFailures = [];
runRegisteredGates({
  gateIds: ['fixture_red_checked'],
  gateMap: new Map([['fixture_red_checked', {
    status: 'active',
    evidence_role: 'red_gate',
    test_name: 'negative_case',
    argv: ['cargo', 'test', 'negative_case'],
  }]]),
  truth: {
    runGate() {
      return { status: 0, stdout: 'running 0 tests\ntest result: ok. 0 passed\n' };
    },
  },
  failures: zeroMatchFailures,
  context: 'regression',
});
assert(
  zeroMatchFailures.some((failure) => failure.code === 'REQUIRED_GATE_TEST_NOT_RUN'),
  'a red gate must not pass when its filtered test did not run',
);

const registryInput = loadCanonicalInput();
const registryPositive = registryInput.verificationMap.gates
  .find((entry) => entry.gate_id === 'v4_runtime_003_plan_bundle_positive');
const registryRed = registryInput.verificationMap.gates
  .find((entry) => entry.gate_id === 'v4_runtime_003_plan_bundle_red');
registryRed.argv = [...registryPositive.argv];
registryRed.command = registryPositive.command;
const registryFailures = [];
validateRegistryBindings(registryInput, registryFailures);
assert(
  registryFailures.some((failure) => failure.code === 'RED_GATE_DUPLICATES_POSITIVE'),
  'a red gate must not reuse its owner feature positive command',
);

process.stdout.write('[test:feature-layer-batch-evidence-regression] PASS\n');
