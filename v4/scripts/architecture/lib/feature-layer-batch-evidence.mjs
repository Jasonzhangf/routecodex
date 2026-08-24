import path from 'node:path';
import {
  ROLE_CONTRACTS,
  addFailure,
  isMachinePath,
  sameOrdered,
  sortedUnique,
} from './feature-layer-batch-contract.mjs';
import { FULL_COMMIT_PATTERN, SHA256_PATTERN } from './feature-layer-batch-git.mjs';

const PHASES = new Set([
  'baseline_reproduction',
  'fix_candidate',
  'positive_intervention',
  'negative_intervention',
  'development_whitebox',
  'deployment_install',
  'deployment_restart',
  'deployed_blackbox',
  'post_architecture_effectiveness',
  'regression',
  'artifact',
]);
const KINDS = new Set([
  'red_test',
  'positive_test',
  'negative_test',
  'sample_replay',
  'build',
  'install',
  'restart',
  'artifact',
  'runtime',
  'gate',
]);
const REQUIRED_FIELDS = [
  'evidence_id',
  'issue_id',
  'experiment_id',
  'phase',
  'kind',
  'source_commit',
  'scope',
  'producer',
  'result',
  'created_at',
  'expires_at',
  'input_hashes',
  'scope_hash',
];
const MAX_EVIDENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function validDate(value) {
  if (!nonEmptyString(value)
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function validateEvidenceRecordShape(evidence, failures, context, now = Date.now()) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    addFailure(failures, 'EVIDENCE_SCHEMA_INVALID', `${context}: record must be an object`);
    return false;
  }
  const missing = REQUIRED_FIELDS.filter((field) => !(field in evidence));
  if (missing.length > 0) {
    addFailure(failures, 'EVIDENCE_SCHEMA_INVALID', `${context}: missing ${missing.join(',')}`);
    return false;
  }
  for (const field of ['evidence_id', 'issue_id', 'experiment_id']) {
    if (!nonEmptyString(evidence[field])) {
      addFailure(failures, 'EVIDENCE_SCHEMA_INVALID', `${context}: ${field} must be non-empty`);
    }
  }
  if (!PHASES.has(evidence.phase) || !KINDS.has(evidence.kind) || evidence.result !== 'pass') {
    addFailure(failures, 'EVIDENCE_SCHEMA_INVALID', `${context}: phase/kind/result is invalid`);
  }
  if (!FULL_COMMIT_PATTERN.test(evidence.source_commit ?? '')
      || !SHA256_PATTERN.test(evidence.scope_hash ?? '')
      || !Array.isArray(evidence.input_hashes)
      || evidence.input_hashes.length === 0
      || evidence.input_hashes.some((hash) => !SHA256_PATTERN.test(hash))) {
    addFailure(failures, 'EVIDENCE_IDENTITY_INVALID', `${context}: commit/input/scope identity is invalid`);
  }
  if (!evidence.scope || !nonEmptyString(evidence.scope.module_id)
      || !nonEmptyString(evidence.scope.feature_id)
      || !evidence.producer || !nonEmptyString(evidence.producer.adapter)
      || !nonEmptyString(evidence.producer.identity)) {
    addFailure(failures, 'EVIDENCE_SCHEMA_INVALID', `${context}: scope and producer identities are required`);
  }
  const createdAt = validDate(evidence.created_at);
  const expiresAt = validDate(evidence.expires_at);
  if (createdAt === null || expiresAt === null
      || createdAt > now || createdAt > expiresAt
      || expiresAt - createdAt > MAX_EVIDENCE_TTL_MS
      || now > expiresAt) {
    addFailure(failures, 'EVIDENCE_EXPIRED_OR_TIME_INVALID', `${context}: evidence time window is invalid`);
  }
  if (evidence.phase === 'development_whitebox'
      && evidence.execution_surface !== 'development_whitebox') {
    addFailure(failures, 'EVIDENCE_SCHEMA_INVALID', `${context}: development whitebox surface is required`);
  }
  return failures.length === 0;
}

function expectedInputHashes(candidate, sourcePaths, gateInputPaths, truth) {
  const identities = sortedUnique([...sourcePaths, ...gateInputPaths]).map((sourcePath) =>
    candidate.blobs.find((identity) => identity.path === sourcePath)
      ?? truth.blobIdentity(candidate.head_commit, sourcePath));
  if (identities.some((identity) => !identity)) return null;
  return sortedUnique(identities.map((identity) => identity.sha256));
}

export function validateEvidenceRef({
  ref,
  evidence,
  expectedRole,
  expectedFeatureId,
  expectedModuleIds,
  expectedGateId,
  candidate,
  sourcePaths,
  gateInputPaths = [],
  gateMap,
  truth,
  integrationCommit,
  failures,
  now,
}) {
  const context = `${expectedFeatureId}:${expectedRole}`;
  if (!ref || typeof ref !== 'object'
      || JSON.stringify(Object.keys(ref).sort()) !== JSON.stringify(['gate_id', 'path', 'role'])) {
    addFailure(failures, 'EVIDENCE_REF_INVALID', `${context}: ref must contain only role/path/gate_id`);
    return;
  }
  if (ref.role !== expectedRole || ref.gate_id !== expectedGateId || !ROLE_CONTRACTS[ref.role]) {
    addFailure(failures, 'EVIDENCE_ROLE_MISMATCH', `${context}: role/task gate mismatch`);
    return;
  }
  if (!isMachinePath(ref.path)
      || !ref.path.startsWith(`docs/evidence/feature-completion/`)
      || !ref.path.includes(`/${expectedFeatureId}/`)
      || path.extname(ref.path) !== '.json') {
    addFailure(failures, 'EVIDENCE_PATH_INVALID', `${context}: evidence path is outside the feature allowlist`);
    return;
  }
  if (!truth.trackedAt(integrationCommit, ref.path) || truth.ignored(ref.path)) {
    addFailure(failures, 'EVIDENCE_PATH_NOT_TRACKED', `${context}: evidence must be tracked and non-ignored`);
  }
  const gate = gateMap.get(ref.gate_id);
  if (!gate || gate.status !== 'active'
      || gate.evidence_role !== ref.role
      || !Array.isArray(gate.argv)
      || gate.argv.length === 0
      || !gate.producer) {
    addFailure(failures, 'EVIDENCE_GATE_BINDING', `${context}: gate ${ref.gate_id} is not an active executable role owner`);
    return;
  }
  validateEvidenceRecordShape(evidence, failures, context, now);
  const contract = ROLE_CONTRACTS[ref.role];
  if (evidence.phase !== contract.phase
      || evidence.kind !== contract.kind
      || (contract.surface && evidence.execution_surface !== contract.surface)) {
    addFailure(failures, 'EVIDENCE_ROLE_CONTRACT_MISMATCH', `${context}: phase/kind/surface drifted`);
  }
  if (evidence.source_commit !== candidate.head_commit
      || evidence.scope_hash !== candidate.scope_hash
      || evidence.scope?.feature_id !== expectedFeatureId
      || !expectedModuleIds.includes(evidence.scope?.module_id)) {
    addFailure(failures, 'EVIDENCE_CANDIDATE_MISMATCH', `${context}: evidence is not bound to the exact task candidate`);
  }
  const hashes = expectedInputHashes(candidate, sourcePaths, gateInputPaths, truth);
  const providedHashes = sortedUnique(evidence.input_hashes ?? []);
  const sharedRuntimeLane = /^V4-RUNTIME-00[56]$/.test(expectedFeatureId);
  const hashBindingValid = sharedRuntimeLane
    ? providedHashes.length > 0 && providedHashes.every((hash) => hashes?.includes(hash))
    : hashes && sameOrdered(providedHashes, hashes);
  if (!hashBindingValid) {
    addFailure(failures, 'EVIDENCE_INPUT_HASH_MISMATCH', `${context}: input hashes do not match candidate source blobs`);
  }
  if (JSON.stringify(evidence.producer) !== JSON.stringify(gate.producer)
      || !sameOrdered(evidence.command_argv ?? [], gate.argv)
      || evidence.exit_status !== 0
      || /review/i.test(`${evidence.producer?.adapter ?? ''}:${evidence.producer?.identity ?? ''}`)) {
    addFailure(failures, 'EVIDENCE_PRODUCER_MISMATCH', `${context}: producer/command receipt is not the registered gate`);
  }
  const expectedId = path.basename(ref.path, '.json');
  if (evidence.evidence_id !== expectedId) {
    addFailure(failures, 'EVIDENCE_ID_PATH_MISMATCH', `${context}: evidence_id must equal its file name`);
  }
}

export function runRegisteredGates({ gateIds, gateMap, truth, failures, context }) {
  for (const gateId of gateIds) {
    const gate = gateMap.get(gateId);
    if (!gate || gate.status !== 'active' || !Array.isArray(gate.argv) || gate.argv.length === 0) {
      addFailure(failures, 'REQUIRED_GATE_NOT_EXECUTABLE', `${context}: ${gateId} is not executable`);
      continue;
    }
    let receipt;
    try {
      receipt = truth.runGate(gate.argv);
    } catch (error) {
      addFailure(failures, 'REQUIRED_GATE_EXECUTION_FAILED', `${context}: ${gateId}: ${error.message}`);
      continue;
    }
    if (receipt.status !== 0) {
      addFailure(failures, 'REQUIRED_GATE_FAILED', `${context}: ${gateId} exited ${receipt.status}`);
    }
  }
}
