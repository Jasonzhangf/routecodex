import path from 'node:path';
import {
  CONDITIONAL_NOT_NEEDED,
  GATE_IDS,
  REQUIRED_BATCH_IDS,
  ROLE_CONTRACTS,
  RUNTIME_MODULE_ID,
  TASK_READY_STATUS,
  addFailure,
  isMachinePath,
  sameOrdered,
  sortedUnique,
} from './feature-layer-batch-contract.mjs';
import { validateEvidenceRecordShape, runRegisteredGates } from './feature-layer-batch-evidence.mjs';
import { validateObservedWiring } from './feature-layer-batch-graph.mjs';
import { validateIntegrationRecords } from './feature-layer-batch-integration.mjs';
import { canonicalJson, sha256 } from './feature-layer-batch-git.mjs';

function readJsonAt(truth, commit, relativePath, failures, code) {
  const identity = truth.blobIdentity(commit, relativePath);
  const bytes = identity ? truth.blob(commit, relativePath) : null;
  if (!identity || bytes === null) {
    addFailure(failures, code, `${relativePath}: tracked regular JSON blob is required`);
    return null;
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    addFailure(failures, code, `${relativePath}: ${error.message}`);
    return null;
  }
}

function expectedLifecycleScope(truth, sourceCommit, featureId, moduleId, sourcePaths) {
  const inputs = [];
  for (const sourcePath of sourcePaths) {
    const identity = truth.blobIdentity(sourceCommit, sourcePath);
    if (!identity) throw new Error(`${sourcePath}: source identity is unavailable`);
    inputs.push(identity);
  }
  const sortedInputs = inputs.sort((left, right) => left.path.localeCompare(right.path));
  return {
    input_hashes: sortedUnique(sortedInputs.map((identity) => identity.sha256)),
    scope_hash: sha256(canonicalJson({
      feature_id: featureId,
      module_id: moduleId,
      source_commit: sourceCommit,
      inputs: sortedInputs,
    })),
  };
}

function validateLifecycleEvidence({
  refs,
  role,
  featureId,
  moduleId,
  sourceCommit,
  sourcePaths,
  input,
  context,
  failures,
  gateIds,
}) {
  if (!Array.isArray(refs) || refs.length !== 1) {
    addFailure(failures, 'LIFECYCLE_EVIDENCE_SET', `${featureId}:${role} must have one evidence ref`);
    return;
  }
  const ref = refs[0];
  if (!ref || canonicalJson(Object.keys(ref).sort()) !== canonicalJson(['gate_id', 'path', 'role'])
      || ref.role !== role
      || !isMachinePath(ref.path)
      || !ref.path.startsWith('docs/evidence/feature-completion/')
      || !ref.path.includes(`/${featureId}/`)
      || path.extname(ref.path) !== '.json') {
    addFailure(failures, 'LIFECYCLE_EVIDENCE_REF', `${featureId}:${role} ref is invalid`);
    return;
  }
  const integrationCommit = context.truth.currentHead();
  const evidence = readJsonAt(context.truth, integrationCommit, ref.path, failures, 'LIFECYCLE_EVIDENCE_JSON');
  if (!evidence) return;
  validateEvidenceRecordShape(evidence, failures, `${featureId}:${role}`, context.now);
  const contract = ROLE_CONTRACTS[role];
  const gate = input.verificationMap.gates.find((entry) => entry.gate_id === ref.gate_id);
  if (!contract || !gate
      || gate.status !== 'active'
      || gate.evidence_role !== role
      || !Array.isArray(gate.argv) || gate.argv.length === 0
      || canonicalJson(evidence.producer) !== canonicalJson(gate.producer)
      || !sameOrdered(evidence.command_argv ?? [], gate.argv)
      || evidence.exit_status !== 0) {
    addFailure(failures, 'LIFECYCLE_EVIDENCE_GATE', `${featureId}:${role} gate binding is invalid`);
    return;
  }
  let expected;
  try {
    expected = expectedLifecycleScope(context.truth, sourceCommit, featureId, moduleId, sourcePaths);
  } catch (error) {
    addFailure(failures, 'LIFECYCLE_EVIDENCE_INPUT', error.message);
    return;
  }
  if (evidence.phase !== contract.phase
      || evidence.kind !== contract.kind
      || (contract.surface && evidence.execution_surface !== contract.surface)
      || evidence.source_commit !== sourceCommit
      || evidence.scope?.feature_id !== featureId
      || evidence.scope?.module_id !== moduleId
      || evidence.scope_hash !== expected.scope_hash
      || !sameOrdered(sortedUnique(evidence.input_hashes ?? []), expected.input_hashes)
      || evidence.evidence_id !== path.basename(ref.path, '.json')) {
    addFailure(failures, 'LIFECYCLE_EVIDENCE_IDENTITY', `${featureId}:${role} is not bound to exact inputs`);
  }
  gateIds.add(ref.gate_id);
}

function validateBaseline(input, context, failures, gateIds) {
  const baseline = input.manifest.baseline;
  const resolved = context.truth.resolveCommit(baseline.required_commit);
  if (!resolved
      || resolved !== baseline.resolved_commit
      || baseline.object_status !== 'reachable'
      || baseline.replay_status !== 'pass'
      || !Array.isArray(baseline.source_paths) || baseline.source_paths.length === 0) {
    addFailure(failures, 'BASELINE_NOT_REPLAYED',
      'RUNTIME-007 exact Git object and replay evidence are required');
    return;
  }
  validateLifecycleEvidence({
    refs: baseline.evidence_refs,
    role: 'baseline_replay',
    featureId: baseline.feature_id,
    moduleId: baseline.runtime_module_id,
    sourceCommit: resolved,
    sourcePaths: baseline.source_paths,
    input,
    context,
    failures,
    gateIds,
  });
}

function validateClosure(input, context, failures, gateIds) {
  const prerequisite = input.manifest.prerequisites[0];
  const batch = input.manifest.batches.find((candidate) => candidate.batch_id === 'H');
  const task = batch?.tasks?.find((candidate) => candidate.task_id === prerequisite.feature_id);
  const auditCommit = context.truth.resolveCommit(prerequisite.audit_commit);
  if (prerequisite.status !== 'pass'
      || !auditCommit || auditCommit !== prerequisite.audit_commit
      || !context.truth.isAncestor(auditCommit, context.truth.currentHead())
      || typeof prerequisite.gap_detected !== 'boolean'
      || !Array.isArray(prerequisite.source_paths) || prerequisite.source_paths.length === 0) {
    addFailure(failures, 'PREREQUISITE_NOT_READY',
      'RUNTIME-002 closure audit must be committed, evidence-bound, and resolved');
    return;
  }
  validateLifecycleEvidence({
    refs: prerequisite.evidence_refs,
    role: 'closure_audit',
    featureId: prerequisite.feature_id,
    moduleId: RUNTIME_MODULE_ID,
    sourceCommit: auditCommit,
    sourcePaths: prerequisite.source_paths,
    input,
    context,
    failures,
    gateIds,
  });
  const expectedStatus = prerequisite.gap_detected ? TASK_READY_STATUS : CONDITIONAL_NOT_NEEDED;
  if (prerequisite.epoch_closure_lane_status !== expectedStatus
      || batch?.status !== expectedStatus
      || task?.status !== expectedStatus) {
    addFailure(failures, 'EPOCH_CLOSURE_STATE_MISMATCH',
      'closure decision and lane H projection disagree');
  }
  if (!prerequisite.gap_detected) {
    validateLifecycleEvidence({
      refs: task.evidence_refs,
      role: 'not_needed_decision',
      featureId: task.task_id,
      moduleId: RUNTIME_MODULE_ID,
      sourceCommit: auditCommit,
      sourcePaths: prerequisite.source_paths,
      input,
      context,
      failures,
      gateIds,
    });
  }
}

function validateBatchReadiness(manifest, failures) {
  for (const batchId of REQUIRED_BATCH_IDS) {
    const batch = manifest.batches.find((candidate) => candidate.batch_id === batchId);
    if (batch?.owner_binding_status !== 'bound' || batch.status !== TASK_READY_STATUS) {
      addFailure(failures, 'BATCH_NOT_READY', `required batch ${batchId} is not source_green`);
    }
  }
  const conditional = manifest.batches.find((batch) => batch.batch_id === 'H');
  if (conditional?.owner_binding_status !== 'bound'
      || ![TASK_READY_STATUS, CONDITIONAL_NOT_NEEDED].includes(conditional.status)) {
    addFailure(failures, 'CONDITIONAL_BATCH_NOT_READY',
      'conditional batch H is not source_green/not_needed_by_evidence');
  }
}

export function validateFeatureLayerAdmission(input, context, failures, options = {}) {
  const gateIds = new Set();
  if (!context.truth.controlledScopeClean(['v4/**'])) {
    addFailure(failures, 'ADMISSION_WORKTREE_DIRTY', 'production admission requires a clean V4 worktree');
  }
  validateBaseline(input, context, failures, gateIds);
  validateClosure(input, context, failures, gateIds);
  validateBatchReadiness(input.manifest, failures);
  validateObservedWiring(input.manifest, context, failures);
  for (const batch of input.manifest.batches) {
    for (const task of batch.tasks) {
      if (task.status === TASK_READY_STATUS) {
        for (const gateId of task.required_gate_ids ?? []) gateIds.add(gateId);
      }
    }
  }
  // The definition gate is the validator currently executing this admission
  // check. Running it as a child would recurse forever; its own definition is
  // already validated above, while the executable positive contract is bound
  // by the dedicated self-test gate.
  for (const forbiddenGate of [GATE_IDS.definition, GATE_IDS.admission, GATE_IDS.buildGuard]) {
    if (gateIds.has(forbiddenGate)) {
      addFailure(failures, 'GATE_SELF_CYCLE', `admission cannot directly execute ${forbiddenGate}`);
      gateIds.delete(forbiddenGate);
    }
  }
  const gateMap = new Map(input.verificationMap.gates.map((gate) => [gate.gate_id, gate]));
  if (options.requireIntegrationRecords !== false) {
    validateIntegrationRecords({
      manifest: input.manifest,
      input,
      context,
      failures,
      expectedGateIds: sortedUnique([...gateIds]),
    });
  }
  runRegisteredGates({
    gateIds: sortedUnique([...gateIds]),
    gateMap,
    truth: context.truth,
    failures,
    context: 'feature-layer admission',
  });
}
