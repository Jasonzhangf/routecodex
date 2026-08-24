import path from 'node:path';
import {
  BASELINE_ANCHOR,
  BASELINE_FEATURE_ID,
  CONDITIONAL_BATCH_IDS,
  CONDITIONAL_NOT_NEEDED,
  EXPECTED_TASKS,
  GUARDED_WIRING_SURFACES,
  IMPLEMENTATION_EXTENSIONS,
  MANIFEST_ID,
  MANIFEST_SCHEMA_VERSION,
  OWNER_FEATURE_ID,
  OWNER_MODULE_ID,
  PLAN_ANCHORS,
  PLAN_HASH,
  PLAN_PATH,
  PREREQUISITE_FEATURE_ID,
  REQUIRED_BATCH_IDS,
  REQUIRED_EVIDENCE_ROLES,
  RUNTIME_MODULE_ID,
  TASK_READY_STATUS,
  addFailure,
  duplicateIds,
  expectedBatchIds,
  isMachinePath,
  isOwnedPattern,
  patternContains,
  patternsOverlap,
  requireExactKeys,
  sameMembers,
  sameOrdered,
} from './feature-layer-batch-contract.mjs';
import { SHA256_PATTERN, sha256 } from './feature-layer-batch-git.mjs';
import { validateRegistryBindings } from './feature-layer-batch-registry.mjs';
import { validateSourceGreenClaims } from './feature-layer-batch-source.mjs';

const ROOT_KEYS = [
  'schema_version', 'manifest_id', 'status', 'owner_feature_id', 'owner_module_id',
  'canonical_contract', 'definition', 'baseline', 'prerequisites', 'batches', 'integration', 'review',
];
const DEFINITION_KEYS = [
  'required_batch_ids', 'conditional_batch_ids', 'source_ready_status',
  'conditional_ready_statuses', 'required_prerequisite_ids', 'required_evidence_roles',
  'integration_owner', 'review_can_satisfy_source', 'normal_payload_carrier',
  'source_dependency_policy', 'candidate_record_schema', 'evidence_record_schema',
];
const BATCH_KEYS = [
  'batch_id', 'conditional', 'owner_binding_status', 'owner_function_id', 'module_ids',
  'owned_paths', 'source_dependencies', 'status', 'tasks',
];
const TASK_KEYS = [
  'task_id', 'status', 'candidate_record', 'function_ids', 'resource_ids', 'source_paths',
  'support_paths', 'required_gate_ids', 'mainline_binding', 'evidence_refs',
];
const PREREQUISITE_KEYS = [
  'feature_id', 'status', 'gap_detected', 'epoch_closure_lane_status',
  'audit_commit', 'source_paths', 'evidence_refs',
];
const REVIEW_KEYS = ['status', 'evidence_refs'];
const VALID_REVIEW_STATUSES = new Set(['not_started', 'pending', 'pass', 'fail', 'unavailable']);
function validateCanonicalContract(manifest, input, failures) {
  const contract = manifest.canonical_contract;
  if (!requireExactKeys(contract, ['path', 'sha256', 'required_anchors'], failures, 'CANONICAL_CONTRACT', 'canonical_contract')) return;
  if (contract.path !== PLAN_PATH
      || contract.sha256 !== PLAN_HASH
      || !sameOrdered(contract.required_anchors ?? [], PLAN_ANCHORS)
      || sha256(input.planSource) !== PLAN_HASH
      || PLAN_ANCHORS.some((anchor) => !input.planSource.includes(anchor))) {
    addFailure(failures, 'CANONICAL_CONTRACT', 'plan path/hash/anchors do not match the current §28 execution contract');
  }
}

function validateBaseline(manifest, truth, failures) {
  const baseline = manifest.baseline;
  if (!requireExactKeys(baseline, [
    'feature_id', 'required_commit', 'resolved_commit', 'runtime_module_id', 'provenance',
    'object_status', 'replay_status', 'source_paths', 'evidence_refs',
  ], failures, 'BASELINE_CONTRACT', 'baseline')) return;
  const resolved = truth.resolveCommit(BASELINE_ANCHOR);
  if (baseline.feature_id !== BASELINE_FEATURE_ID
      || baseline.required_commit !== BASELINE_ANCHOR
      || baseline.runtime_module_id !== RUNTIME_MODULE_ID
      || baseline.provenance !== 'current_v4_tree'
      || baseline.object_status !== 'reachable'
      || baseline.replay_status !== 'pass'
      || !Array.isArray(baseline.source_paths)
      || !Array.isArray(baseline.evidence_refs)) {
    addFailure(failures, 'BASELINE_CONTRACT', 'R007 anchor/owner/provenance/status drifted');
  }
  if (resolved === null || baseline.resolved_commit !== resolved) {
    addFailure(failures, 'BASELINE_OBJECT_STATUS_DRIFT', 'current V4 baseline must resolve to the exact declared tree commit');
  }
}

function validateGuard(manifest, truth, failures, allowPendingGuard) {
  const integration = manifest.integration;
  const guardOwnerTask = (manifest.batches ?? [])
    .find((batch) => batch.batch_id === 'G')?.tasks
    ?.find((task) => task.task_id === MANIFEST_ID);
  if (!requireExactKeys(integration, [
    'owner', 'admission_command', 'enforcement_binding_status', 'guard_commit',
    'guarded_surfaces', 'wiring_started', 'wiring_edges', 'resource_refs', 'evidence_refs',
  ], failures, 'INTEGRATION_STATE_INVALID', 'integration')) return;
  if (integration.owner !== manifest.definition.integration_owner
      || integration.admission_command !== 'node scripts/architecture/verify-v4-feature-layer-batches.mjs --admission'
      || !['pending_candidate', 'bound'].includes(integration.enforcement_binding_status)
      || typeof integration.wiring_started !== 'boolean'
      || !Array.isArray(integration.wiring_edges)
      || !Array.isArray(integration.evidence_refs)
      || !requireExactKeys(integration.resource_refs, ['merge_queue_state', 'integration_candidate'], failures, 'INTEGRATION_RESOURCE_REFS', 'integration.resource_refs')) {
    addFailure(failures, 'INTEGRATION_STATE_INVALID', 'integration owner/admission/typed state drifted');
  }
  const surfaces = integration.guarded_surfaces ?? [];
  if (!sameOrdered(surfaces.map((surface) => surface.path), GUARDED_WIRING_SURFACES)
      || surfaces.some((surface) => !requireExactKeys(surface, ['path', 'scope_hash'], failures, 'GUARD_SURFACE_INVALID', `guard ${surface.path}`))) {
    addFailure(failures, 'GUARD_SURFACE_INVALID', 'guarded wiring surface set drifted');
  }
  if (integration.enforcement_binding_status === 'pending_candidate') {
    if (!allowPendingGuard || integration.guard_commit !== null
        || surfaces.some((surface) => surface.scope_hash !== null)) {
      addFailure(failures, 'INTEGRATION_GUARD_UNBOUND', 'guard commit/hashes must be bound before the definition gate is active');
    }
    return;
  }
  if (guardOwnerTask?.status !== TASK_READY_STATUS
      || !isMachinePath(guardOwnerTask.candidate_record)) {
    addFailure(failures, 'GUARD_OWNER_TASK_NOT_READY',
      'bound guard requires the exact source_green V4-LAYER-GATE-001 candidate');
  }
  const guardCommit = truth.resolveCommit(integration.guard_commit);
  if (!guardCommit || guardCommit !== integration.guard_commit) {
    addFailure(failures, 'INTEGRATION_GUARD_COMMIT_INVALID', 'guard_commit must be an exact reachable full commit');
    return;
  }
  for (const surface of surfaces) {
    let expected;
    let current;
    try {
      expected = truth.scopeHashAt(guardCommit, [surface.path]);
      current = truth.currentScopeHash([surface.path]);
    } catch (error) {
      addFailure(failures, 'GUARD_SURFACE_UNREADABLE', `${surface.path}: ${error.message}`);
      continue;
    }
    if (!SHA256_PATTERN.test(surface.scope_hash ?? '') || surface.scope_hash !== expected) {
      addFailure(failures, 'GUARD_SURFACE_HASH_MISMATCH', `${surface.path}: stored guard hash does not match guard commit`);
    }
    if (!integration.wiring_started && current !== expected) {
      addFailure(failures, 'EARLY_WIRING_SURFACE_CHANGED', `${surface.path}: production wiring changed before admission`);
    }
  }
}

function validateBatchSkeleton(manifest, registries, failures) {
  const batches = manifest.batches ?? [];
  const ids = batches.map((batch) => batch.batch_id);
  if (!sameMembers(ids, expectedBatchIds())) addFailure(failures, 'BATCH_SET_MISMATCH', 'batch set must be exactly A-H');
  const duplicateBatchIds = duplicateIds(batches, 'batch_id');
  if (duplicateBatchIds.length > 0) addFailure(failures, 'DUPLICATE_BATCH_ID', duplicateBatchIds.join(','));
  const claimedModules = new Map();
  const claimedPatterns = [];
  const taskOwners = new Map();
  const taskPaths = new Map();
  for (const batch of batches) {
    if (!requireExactKeys(batch, BATCH_KEYS, failures, 'BATCH_SCHEMA', `batch ${batch.batch_id}`)) continue;
    const expectedTasks = EXPECTED_TASKS.get(batch.batch_id) ?? [];
    const tasks = batch.tasks ?? [];
    if (!sameMembers(tasks.map((task) => task.task_id), expectedTasks)
        || duplicateIds(tasks, 'task_id').length > 0) {
      addFailure(failures, 'TASK_SET_MISMATCH', `batch ${batch.batch_id} task set drifted`);
    }
    if (batch.conditional !== (batch.batch_id === 'H')
        || !['pending', 'bound'].includes(batch.owner_binding_status)
        || !['pending', TASK_READY_STATUS, CONDITIONAL_NOT_NEEDED].includes(batch.status)
        || !Array.isArray(batch.source_dependencies) || batch.source_dependencies.length !== 0) {
      addFailure(failures, 'BATCH_STATE_INVALID', `batch ${batch.batch_id} flags/status/dependencies drifted`);
    }
    if (batch.owner_binding_status === 'pending') {
      if (batch.owner_function_id !== null || (batch.module_ids ?? []).length > 0
          || (batch.owned_paths ?? []).length > 0 || batch.status !== 'pending'
          || tasks.some((task) => task.status !== 'pending' || task.candidate_record !== null
            || (task.source_paths ?? []).length > 0 || (task.support_paths ?? []).length > 0
            || (task.evidence_refs ?? []).length > 0)) {
        addFailure(failures, 'PENDING_OWNER_PRETENDS_BOUND', `batch ${batch.batch_id} claims source truth before owner binding`);
      }
    } else {
      const ownerFn = registries.functions.get(batch.owner_function_id);
      if (!ownerFn || !(batch.module_ids ?? []).includes(ownerFn.owner)
          || (batch.module_ids ?? []).length === 0 || (batch.owned_paths ?? []).length === 0) {
        addFailure(failures, 'BATCH_OWNER_BINDING', `batch ${batch.batch_id} owner function/modules/paths are not registered`);
      }
      for (const moduleId of batch.module_ids ?? []) {
        const module = registries.modules.get(moduleId);
        if (!module || module.status !== 'active' || module.owner !== moduleId) {
          addFailure(failures, 'BATCH_MODULE_BINDING', `batch ${batch.batch_id} module ${moduleId} is not an active unique owner`);
        }
        if (claimedModules.has(moduleId)) {
          addFailure(failures, 'DUPLICATE_BATCH_MODULE_OWNER', `${moduleId} is shared by batches ${claimedModules.get(moduleId)} and ${batch.batch_id}`);
        }
        claimedModules.set(moduleId, batch.batch_id);
      }
      for (const ownedPath of batch.owned_paths ?? []) {
        if (!isOwnedPattern(ownedPath)) {
          addFailure(failures, 'BATCH_OWNED_PATH_INVALID', `${batch.batch_id}:${ownedPath}`);
          continue;
        }
        const owners = (batch.module_ids ?? []).filter((moduleId) =>
          (registries.modules.get(moduleId)?.owned_paths ?? [])
            .some((pattern) => patternContains(pattern, ownedPath)));
        if (owners.length !== 1) addFailure(failures, 'BATCH_MODULE_PATH_DRIFT', `${batch.batch_id}:${ownedPath}`);
        for (const prior of claimedPatterns) {
          if (prior.batchId !== batch.batch_id && patternsOverlap(prior.path, ownedPath)) {
            addFailure(failures, 'OVERLAPPING_OWNED_PATH', `${prior.batchId}/${batch.batch_id}:${prior.path}/${ownedPath}`);
          }
        }
        claimedPatterns.push({ batchId: batch.batch_id, path: ownedPath });
      }
    }
    const statuses = [];
    for (const task of tasks) {
      if (!requireExactKeys(task, TASK_KEYS, failures, 'TASK_SCHEMA', task.task_id)) continue;
      if (taskOwners.has(task.task_id)) addFailure(failures, 'DUPLICATE_TASK_ID', task.task_id);
      taskOwners.set(task.task_id, batch.batch_id);
      if (!['pending', TASK_READY_STATUS, CONDITIONAL_NOT_NEEDED].includes(task.status)
          || task.mainline_binding !== 'forbidden_before_integration') {
        addFailure(failures, 'TASK_STATE_INVALID', `${task.task_id}: status/mainline binding drifted`);
      }
      if (task.status === CONDITIONAL_NOT_NEEDED && batch.batch_id !== 'H') {
        addFailure(failures, 'NOT_NEEDED_ON_REQUIRED_TASK', task.task_id);
      }
      if (task.status === 'pending' && (task.candidate_record !== null
          || (task.source_paths ?? []).length > 0 || (task.support_paths ?? []).length > 0
          || (task.evidence_refs ?? []).length > 0)) {
        addFailure(failures, 'PENDING_TASK_CLAIMS_CANDIDATE', task.task_id);
      }
      if (task.status === CONDITIONAL_NOT_NEEDED && (task.candidate_record !== null
          || (task.function_ids ?? []).length > 0 || (task.resource_ids ?? []).length > 0
          || (task.source_paths ?? []).length > 0 || (task.support_paths ?? []).length > 0
          || (task.required_gate_ids ?? []).length > 0)) {
        addFailure(failures, 'NOT_NEEDED_TASK_HAS_SOURCE', task.task_id);
      }
      for (const sourcePath of [...(task.source_paths ?? []), ...(task.support_paths ?? [])]) {
        if (!isMachinePath(sourcePath)) addFailure(failures, 'TASK_PATH_INVALID', `${task.task_id}:${sourcePath}`);
        if (taskPaths.has(sourcePath)) addFailure(failures, 'DUPLICATE_TASK_PATH', `${sourcePath}:${taskPaths.get(sourcePath)}/${task.task_id}`);
        taskPaths.set(sourcePath, task.task_id);
      }
      for (const supportPath of task.support_paths ?? []) {
        if (IMPLEMENTATION_EXTENSIONS.has(path.extname(supportPath))) {
          addFailure(failures, 'IMPLEMENTATION_HIDDEN_AS_SUPPORT', `${task.task_id}:${supportPath}`);
        }
      }
      statuses.push(task.status);
    }
    const derivedStatus = batch.batch_id === 'H' && statuses.length > 0
      && statuses.every((status) => status === CONDITIONAL_NOT_NEEDED)
      ? CONDITIONAL_NOT_NEEDED
      : statuses.length > 0 && statuses.every((status) => status === TASK_READY_STATUS)
        ? TASK_READY_STATUS
        : 'pending';
    if (batch.status !== derivedStatus) addFailure(failures, 'BATCH_STATUS_DRIFT', `${batch.batch_id}:${batch.status}/${derivedStatus}`);
  }
}

function validateClosureProjection(manifest, failures) {
  const prerequisite = manifest.prerequisites?.[0];
  const batch = (manifest.batches ?? []).find((candidate) => candidate.batch_id === 'H');
  const task = batch?.tasks?.find((candidate) => candidate.task_id === PREREQUISITE_FEATURE_ID);
  if (!prerequisite || !batch || !task) return;
  if (prerequisite.status === 'pending') {
    if (batch.status !== 'pending' || task.status !== 'pending') {
      addFailure(failures, 'EPOCH_CLOSURE_STATE_MISMATCH',
        'pending closure audit requires pending conditional lane H');
    }
    return;
  }
  const closureRoles = (prerequisite.evidence_refs ?? []).map((ref) => ref?.role);
  if (prerequisite.status !== 'pass'
      || typeof prerequisite.gap_detected !== 'boolean'
      || !sameOrdered(closureRoles, ['closure_audit'])) {
    addFailure(failures, 'RUNTIME_002_CLOSURE_EVIDENCE',
      'passed RUNTIME-002 closure requires one closure_audit evidence ref and a boolean decision');
    return;
  }
  const expectedStatus = prerequisite.gap_detected ? TASK_READY_STATUS : CONDITIONAL_NOT_NEEDED;
  if (prerequisite.epoch_closure_lane_status !== expectedStatus
      || batch.status !== expectedStatus
      || task.status !== expectedStatus) {
    addFailure(failures, 'EPOCH_CLOSURE_STATE_MISMATCH',
      'RUNTIME-002 decision and conditional lane H status disagree');
  }
  if (!prerequisite.gap_detected) {
    const decisionRoles = (task.evidence_refs ?? []).map((ref) => ref?.role);
    if (!sameOrdered(decisionRoles, ['not_needed_decision'])) {
      addFailure(failures, 'NOT_NEEDED_EVIDENCE_MISSING',
        'not_needed_by_evidence requires one not_needed_decision record');
    }
  }
}

export function validateFeatureLayerDefinition(input, context, options = {}) {
  const failures = [];
  const manifest = input.manifest;
  if (!requireExactKeys(manifest, ROOT_KEYS, failures, 'MANIFEST_SCHEMA', 'manifest')) return failures;
  if (manifest.schema_version !== MANIFEST_SCHEMA_VERSION || manifest.manifest_id !== MANIFEST_ID
      || manifest.status !== 'active' || manifest.owner_feature_id !== OWNER_FEATURE_ID
      || manifest.owner_module_id !== OWNER_MODULE_ID) {
    addFailure(failures, 'MANIFEST_IDENTITY', 'manifest schema/id/status/owner drifted');
  }
  validateCanonicalContract(manifest, input, failures);
  if (!requireExactKeys(manifest.definition, DEFINITION_KEYS, failures, 'DEFINITION_SCHEMA', 'definition')) return failures;
  const definition = manifest.definition;
  if (!sameMembers(definition.required_batch_ids ?? [], REQUIRED_BATCH_IDS)
      || !sameMembers(definition.conditional_batch_ids ?? [], CONDITIONAL_BATCH_IDS)
      || definition.source_ready_status !== TASK_READY_STATUS
      || !sameMembers(definition.conditional_ready_statuses ?? [], [TASK_READY_STATUS, CONDITIONAL_NOT_NEEDED])
      || !sameMembers(definition.required_prerequisite_ids ?? [], [PREREQUISITE_FEATURE_ID])
      || !sameMembers(definition.required_evidence_roles ?? [], REQUIRED_EVIDENCE_ROLES)
      || definition.integration_owner !== 'v4.feature_completion.integration'
      || definition.review_can_satisfy_source !== false
      || definition.normal_payload_carrier !== 'forbidden'
      || definition.source_dependency_policy !== 'shared_contract_modules_only_before_wiring'
      || definition.candidate_record_schema !== 'contracts/records/fix-candidate-record.schema.json'
      || definition.evidence_record_schema !== 'contracts/records/evidence-record.schema.json') {
    addFailure(failures, 'DEFINITION_CONTRACT', 'batch/readiness/evidence/plane/integration contract drifted');
  }
  const registries = validateRegistryBindings(input, failures);
  validateBaseline(manifest, context.truth, failures);
  const prerequisites = manifest.prerequisites ?? [];
  if (prerequisites.length !== 1 || prerequisites[0]?.feature_id !== PREREQUISITE_FEATURE_ID) {
    addFailure(failures, 'PREREQUISITE_SET', 'RUNTIME-002 closure audit must exist exactly once');
  } else {
    const prerequisite = prerequisites[0];
    if (!requireExactKeys(prerequisite, PREREQUISITE_KEYS, failures, 'PREREQUISITE_SCHEMA', 'prerequisite RUNTIME-002')
        || !['pending', 'pass'].includes(prerequisite.status)
        || !['pending', TASK_READY_STATUS, CONDITIONAL_NOT_NEEDED].includes(prerequisite.epoch_closure_lane_status)
        || !Array.isArray(prerequisite.evidence_refs)
        || !Array.isArray(prerequisite.source_paths)
        || (prerequisite.status === 'pending'
          && (prerequisite.gap_detected !== null
            || prerequisite.epoch_closure_lane_status !== 'pending'
            || prerequisite.audit_commit !== null
            || prerequisite.source_paths.length > 0
            || prerequisite.evidence_refs.length > 0))) {
      addFailure(failures, 'PREREQUISITE_STATE', 'RUNTIME-002 closure state is not evidence-derived');
    }
  }
  validateBatchSkeleton(manifest, registries, failures);
  validateClosureProjection(manifest, failures);
  validateGuard(manifest, context.truth, failures, options.allowPendingGuard === true);
  if (!requireExactKeys(manifest.review, REVIEW_KEYS, failures, 'REVIEW_SCHEMA', 'review')
      || !VALID_REVIEW_STATUSES.has(manifest.review?.status)
      || !Array.isArray(manifest.review?.evidence_refs)
      || (!manifest.integration?.wiring_started
        && (manifest.review?.status !== 'not_started' || manifest.review.evidence_refs.length > 0))) {
    addFailure(failures, 'EARLY_OR_INVALID_REVIEW', 'review must remain outside pre-wiring source completion');
  }
  const anyPending = (manifest.batches ?? []).some((batch) => batch.status === 'pending')
    || prerequisites[0]?.status !== 'pass'
    || manifest.baseline?.object_status !== 'reachable'
    || manifest.baseline?.replay_status !== 'pass';
  if (manifest.integration?.wiring_started && anyPending) addFailure(failures, 'EARLY_WIRING', 'wiring opened before every source/prerequisite was ready');
  if (((manifest.integration?.wiring_edges ?? []).length > 0) !== manifest.integration?.wiring_started) {
    addFailure(failures, 'WIRING_STATE_DRIFT', 'wiring_started and wiring_edges must change together');
  }
  validateSourceGreenClaims(input, context, failures);
  for (const edge of input.mainlineMap.edges ?? []) {
    const serialized = JSON.stringify(edge);
    if (!manifest.integration?.wiring_started
        && (manifest.batches ?? []).flatMap((batch) => batch.tasks ?? [])
          .some((task) => serialized.includes(task.task_id))) {
      addFailure(failures, 'EARLY_MAINLINE_BINDING', 'source task entered mainline before integration admission');
    }
  }
  return failures;
}
