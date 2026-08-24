import {
  MANIFEST_ID,
  REQUIRED_EVIDENCE_ROLES,
  TASK_READY_STATUS,
  addFailure,
  duplicateIds,
  isMachinePath,
  sameMembers,
  sortedUnique,
} from './feature-layer-batch-contract.mjs';
import { validateCandidateRecord, validateTaskRegistryProjection } from './feature-layer-batch-candidate.mjs';
import { validateEvidenceRef } from './feature-layer-batch-evidence.mjs';
import {
  validateGuardCandidateBootstrap,
  validateTaskSourceGraph,
} from './feature-layer-batch-graph.mjs';
import { canonicalJson } from './feature-layer-batch-git.mjs';

const SHARED_PROJECTION_PATHS = new Set([
  'docs/architecture/maps/function-map.json',
  '.appsdk/maps/module-registry.json',
  'docs/architecture/maps/resource-map.json',
  'docs/architecture/maps/verification-map.json',
  'contracts/feature-completion-layer-batches.manifest.json',
  'contracts/data-control-boundary.contract.json',
  'docs/architecture/v4-resource-operation-map.yml',
  'package.json',
  'scripts/_gate-matrix.mjs',
]);

function readJsonAt(truth, commit, relativePath, failures, code, context) {
  const identity = truth.blobIdentity(commit, relativePath);
  const bytes = identity ? truth.blob(commit, relativePath) : null;
  if (!identity || bytes === null) {
    addFailure(failures, code, `${context}: tracked regular JSON blob is required`);
    return null;
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    addFailure(failures, code, `${context}: ${error.message}`);
    return null;
  }
}

function selectedEntries(items, key, ids) {
  const selected = (items ?? []).filter((entry) => ids.includes(entry[key]));
  return selected.sort((left, right) => String(left[key]).localeCompare(String(right[key])));
}

function stableProjection(kind, entries) {
  if (kind !== 'module') return entries;
  return entries.map((entry) => ({
    module_id: entry.module_id,
    status: entry.status,
    owner: entry.owner,
    owned_paths: entry.owned_paths,
  }));
}

function validateProjectionStability({
  task,
  batch,
  candidateMaps,
  candidateGateInputContract,
  input,
  failures,
}) {
  const comparisons = [
    ['function', candidateMaps.functionMap.functions, input.functionMap.functions, 'function_id', task.function_ids ?? []],
    ['resource', candidateMaps.resourceMap.resources, input.resourceMap.resources, 'resource_id', task.resource_ids ?? []],
    ['gate', candidateMaps.verificationMap.gates, input.verificationMap.gates, 'gate_id', task.required_gate_ids ?? []],
    ['module', candidateMaps.moduleRegistry.modules, input.moduleRegistry.modules, 'module_id', batch.module_ids ?? []],
  ];
  for (const [kind, candidateItems, currentItems, key, ids] of comparisons) {
    const candidateProjection = stableProjection(kind, selectedEntries(candidateItems, key, ids));
    const currentProjection = stableProjection(kind, selectedEntries(currentItems, key, ids));
    if (candidateProjection.length !== ids.length
        || currentProjection.length !== ids.length
        || canonicalJson(candidateProjection) !== canonicalJson(currentProjection)) {
      addFailure(failures, 'CANDIDATE_REGISTRY_PROJECTION_DRIFT',
        `${task.task_id}: ${kind} projection changed after candidate`);
    }
  }
  if (canonicalJson(candidateGateInputContract) !== canonicalJson(input.gateInputContract)) {
    addFailure(failures, 'CANDIDATE_GATE_INPUT_CONTRACT_DRIFT',
      `${task.task_id}: gate input contract changed after candidate`);
  }
}

function candidateMatchesCurrent(candidate, relativePath, truth) {
  const candidateBlob = candidate.blobs.find((entry) => entry.path === relativePath);
  const currentBlob = truth.currentBlobIdentity(relativePath);
  if (candidateBlob?.status === 'D') return currentBlob === null;
  if (!candidateBlob || !currentBlob) return false;
  return canonicalJson(currentBlob) === canonicalJson({
    path: candidateBlob.path,
    mode: candidateBlob.mode,
    git_oid: candidateBlob.git_oid,
    sha256: candidateBlob.sha256,
  });
}

function commitPathMatchesCurrent(commit, relativePath, truth) {
  const candidateBlob = truth.blobIdentity(commit, relativePath);
  const currentBlob = truth.currentBlobIdentity(relativePath);
  return candidateBlob !== null && currentBlob !== null
    && canonicalJson(candidateBlob) === canonicalJson(currentBlob);
}

export function validateSourceGreenClaims(input, context, failures) {
  const integrationCommit = context.truth.currentHead();
  for (const batch of input.manifest.batches ?? []) {
    const readyTasks = (batch.tasks ?? []).filter((task) => task.status === TASK_READY_STATUS);
    const candidateGroups = new Map();
    for (const task of readyTasks) {
      if (!isMachinePath(task.candidate_record)) {
        addFailure(failures, 'SOURCE_GREEN_CANDIDATE_MISSING', task.task_id);
        continue;
      }
      const group = candidateGroups.get(task.candidate_record) ?? [];
      group.push(task);
      candidateGroups.set(task.candidate_record, group);
    }
    for (const [recordPath, tasks] of candidateGroups) {
      const record = readJsonAt(context.truth, integrationCommit, recordPath, failures,
        'CANDIDATE_RECORD_INVALID_JSON', recordPath);
      const candidateMaps = record ? {
        functionMap: readJsonAt(context.truth, record.head_commit,
          'docs/architecture/maps/function-map.json', failures, 'CANDIDATE_MAP_INVALID', 'candidate function map'),
        moduleRegistry: readJsonAt(context.truth, record.head_commit,
          '.appsdk/maps/module-registry.json', failures, 'CANDIDATE_MAP_INVALID', 'candidate module registry'),
        resourceMap: readJsonAt(context.truth, record.head_commit,
          'docs/architecture/maps/resource-map.json', failures, 'CANDIDATE_MAP_INVALID', 'candidate resource map'),
        verificationMap: readJsonAt(context.truth, record.head_commit,
          'docs/architecture/maps/verification-map.json', failures, 'CANDIDATE_MAP_INVALID', 'candidate verification map'),
        gateInputContract: readJsonAt(context.truth, record.head_commit,
          'contracts/feature-layer-gate-inputs.contract.json', failures,
          'CANDIDATE_GATE_INPUT_CONTRACT_INVALID', 'candidate gate input contract'),
      } : null;
      const candidate = validateCandidateRecord({
        recordPath,
        record,
        batch,
        tasks,
        moduleRegistry: candidateMaps?.moduleRegistry ?? { modules: [] },
        truth: context.truth,
        integrationCommit,
        failures,
      });
      if (!candidate || !candidateMaps
          || Object.values(candidateMaps).some((map) => map === null)) continue;
      const candidateGateMap = new Map((candidateMaps.verificationMap.gates ?? [])
        .map((gate) => [gate.gate_id, gate]));
      for (const task of tasks) {
        if (task.task_id === MANIFEST_ID
            && input.manifest.integration.guard_commit !== candidate.head_commit) {
          addFailure(failures, 'GUARD_COMMIT_CANDIDATE_MISMATCH',
            'guard commit must remain the exact V4-LAYER-GATE-001 source candidate');
        }
        if (task.task_id === MANIFEST_ID) {
          validateGuardCandidateBootstrap(input.manifest, context, candidate, failures);
        }
        const projection = validateTaskRegistryProjection({
          task,
          batch,
          functionMap: candidateMaps.functionMap,
          resourceMap: candidateMaps.resourceMap,
          gateMap: candidateGateMap,
          gateInputContract: candidateMaps.gateInputContract,
          truth: context.truth,
          candidateCommit: candidate.head_commit,
          failures,
        });
        validateProjectionStability({
          task,
          batch,
          candidateMaps,
          candidateGateInputContract: candidateMaps.gateInputContract,
          input,
          failures,
        });
        const ownerMatchesCandidate = (owner) => owner === record.module_id
          || owner?.startsWith(`${record.module_id}::`);
        if (projection.functions.some((fn) => !ownerMatchesCandidate(fn.owner))
            || projection.resources.some((resource) => !ownerMatchesCandidate(resource.owner))) {
          addFailure(failures, 'CANDIDATE_PROJECTION_OWNER_MISMATCH',
            `${task.task_id}: function/resource owner differs from candidate owner`);
        }
        validateTaskSourceGraph({
          manifest: input.manifest,
          moduleRegistry: input.moduleRegistry,
          batch,
          task,
          baselineCommit: candidate.base_commit,
          candidateCommit: candidate.head_commit,
          truth: context.truth,
          failures,
        });
        const roles = (task.evidence_refs ?? []).map((ref) => ref.role);
        if (!sameMembers(roles, REQUIRED_EVIDENCE_ROLES)
            || duplicateIds(task.evidence_refs, 'role').length > 0) {
          addFailure(failures, 'EVIDENCE_ROLE_SET',
            `${task.task_id}: exactly four source roles are required`);
          continue;
        }
        for (const role of REQUIRED_EVIDENCE_ROLES) {
          const ref = task.evidence_refs.find((candidateRef) => candidateRef.role === role);
          const roleGates = projection.gateIds.filter((gateId) =>
            candidateGateMap.get(gateId)?.evidence_role === role);
          if (roleGates.length !== 1 || ref?.gate_id !== roleGates[0]) {
            addFailure(failures, 'EVIDENCE_TASK_GATE_OWNER',
              `${task.task_id}:${role} must have one projected gate owner`);
            continue;
          }
          const evidence = ref ? readJsonAt(context.truth, integrationCommit, ref.path, failures,
            'EVIDENCE_INVALID_JSON', ref.path) : null;
          if (!ref || !evidence) continue;
          validateEvidenceRef({
            ref,
            evidence,
            expectedRole: role,
            expectedFeatureId: task.task_id,
            expectedModuleIds: batch.module_ids,
            expectedGateId: roleGates[0],
            candidate,
            sourcePaths: sortedUnique([...(task.source_paths ?? []), ...(task.support_paths ?? [])]),
            gateInputPaths: projection.gateInputPaths,
            gateMap: candidateGateMap,
            truth: context.truth,
            integrationCommit,
            failures,
            now: context.now,
          });
        }
        for (const candidatePath of sortedUnique([
          ...projection.sourcePaths,
          ...(task.support_paths ?? []),
        ])) {
          if (!SHARED_PROJECTION_PATHS.has(candidatePath)
              && !candidateMatchesCurrent(candidate, candidatePath, context.truth)) {
            addFailure(failures, 'CANDIDATE_SOURCE_DRIFT', `${task.task_id}:${candidatePath}`);
          }
        }
        for (const inputPath of projection.gateInputPaths) {
          if (!commitPathMatchesCurrent(candidate.head_commit, inputPath, context.truth)) {
            addFailure(failures, 'CANDIDATE_GATE_INPUT_DRIFT', `${task.task_id}:${inputPath}`);
          }
        }
      }
    }
  }
}
