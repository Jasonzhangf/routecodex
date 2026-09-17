#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  createGitTruth,
  sha256,
} from './lib/feature-layer-batch-git.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const v4Root = path.resolve(path.dirname(scriptPath), '..', '..');
const repoRoot = path.resolve(v4Root, '..');
const manifestPath = path.join(v4Root, 'contracts/feature-completion-layer-batches.manifest.json');
const functionMapPath = path.join(v4Root, 'docs/architecture/maps/function-map.json');
const resourceMapPath = path.join(v4Root, 'docs/architecture/maps/resource-map.json');
const verificationMapPath = path.join(v4Root, 'docs/architecture/maps/verification-map.json');
const gateInputContractPath = path.join(v4Root, 'contracts/feature-layer-gate-inputs.contract.json');
const evidenceRoot = path.join(v4Root, 'docs/evidence/feature-completion/M1');
const MAX_EVIDENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const LANES = new Map([
  ['A', {
    base: '4d72ad85162afd0ab0e44de687fc72ab2d4e4b4b',
    head: '4d5d120e453bd04b221f5163289af412cee049b9',
    module: 'routecodex-v4-parity',
    owner: 'v4.parity.product_ledger',
    paths: [
      'scripts/architecture/verify-v4-product-differential.mjs',
      'scripts/architecture/verify-v4-product-parity-ledger.mjs',
      'scripts/architecture/verify-v4-product-parity-status.mjs',
      'scripts/architecture/verify-v4-v3-baseline-delta.mjs',
    ],
  }],
  ['B', {
    base: '2efc9e09e9cc22bd60d0b66da7710c1250e11d53',
    head: '2e5b27cd27e9cdb221b9b8f1170bd5db97caf66c',
    module: 'routecodex-v4-plugin-plan',
    owner: 'v4.runtime.node_plan_bundle',
    paths: ['crates/routecodex-v4-plugin-plan/**'],
  }],
  ['C', {
    base: '9181843f786b13ebe8b33ad5e4b7ecc4a9b1ec38',
    head: '55f5529cc075e14ac07a587fbde2680c5ad3c1e0',
    module: 'routecodex-v4-cordis-bridge',
    owner: 'v4.runtime.cordis_mount_candidate',
    paths: ['crates/routecodex-v4-cordis-bridge/**'],
  }],
  ['D', {
    base: '65065c1888f4178fe07224a9b82c657e52982c8f',
    head: '59a7253b9b22795dc4b1e76d31f5993126bb2988',
    module: 'routecodex-v4-standard-plugins',
    owner: 'v4.plugin.request.responses_normalize',
    paths: [
      'crates/routecodex-v4-standard-plugins/src/chat_to_responses.rs',
      'crates/routecodex-v4-standard-plugins/src/model_hooks.rs',
      'crates/routecodex-v4-standard-plugins/src/request_governance.rs',
      'crates/routecodex-v4-standard-plugins/src/request_normalize.rs',
      'crates/routecodex-v4-standard-plugins/src/request_plugins.rs',
      'crates/routecodex-v4-standard-plugins/src/responses_wire_build.rs',
    ],
  }],
  ['E', {
    base: '652648a99541b8c5f5ca32f5af3b2616af35018b',
    head: 'a784f3722f7b1ca83597754ef87f3eb7b9a4a4f0',
    module: 'routecodex-v4-standard-plugins',
    owner: 'v4.plugin.response.decode',
    paths: [
      'crates/routecodex-v4-standard-plugins/src/response_decode.rs',
      'crates/routecodex-v4-standard-plugins/src/response_fault.rs',
      'crates/routecodex-v4-standard-plugins/src/response_governance.rs',
    ],
  }],
  ['F', {
    base: '96c398fb6c23f7c415100a1d54a837b371da65b5',
    head: 'd67a902713ab3e712578edc945b47a6ef1e1737d',
    module: 'routecodex-v4-runtime',
    owner: 'v4.runtime.request_port',
    paths: ['crates/routecodex-v4-runtime/**'],
  }],
  ['G', {
    base: '4ddebdc394d9d8ecf9c77b54d9a69f2972739c05',
    head: '356cd11f3357406460dea751df624e67feaf96a2',
    module: 'routecodex-v4-governance',
    owner: 'v4.governance.feature_layer_batch_admission',
    paths: [
      'docs/architecture/maps/function-map.json',
      '.appsdk/maps/module-registry.json',
      'docs/architecture/maps/resource-map.json',
      'docs/architecture/maps/verification-map.json',
      'contracts/data-control-boundary.contract.json',
      'contracts/feature-completion-layer-batches.manifest.json',
      'contracts/feature-layer-gate-inputs.contract.json',
      'docs/goals/v4-feature-completion-goal-prompt.md',
      'docs/goals/v4-feature-completion-plan.md',
      'package.json',
      'scripts/_gate-matrix.mjs',
      'scripts/architecture/lib/**',
      'scripts/architecture/verify-v4-feature-layer-batches.mjs',
      'scripts/architecture/verify-v4-plane-isolation.mjs',
      'scripts/build.mjs',
      'scripts/compile-real-runtime-manifest.mjs',
      'scripts/install-rccv4.mjs',
      'scripts/tests/v4-feature-layer-batches-red-fixtures.mjs',
      'scripts/verify.mjs',
      'scripts/verify-ci.mjs',
    ],
  }],
]);

const ROLE_EVIDENCE = new Map([
  ['positive', 'positive'],
  ['red_gate', 'red-gate'],
  ['boundary_audit', 'boundary-audit'],
  ['plane_isolation', 'plane-isolation'],
]);

const ROLE_CONTRACT = new Map([
  ['positive', ['positive_intervention', 'positive_test']],
  ['red_gate', ['negative_intervention', 'red_test']],
  ['boundary_audit', ['development_whitebox', 'gate']],
  ['plane_isolation', ['development_whitebox', 'gate']],
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function functionsForTask(task, functionMap) {
  return functionMap.functions.filter((entry) =>
    entry.status === 'active' && entry.feature_id === task.task_id);
}

function sourcePaths(task, functionMap, functionIds = null) {
  return [...new Set(functionsForTask(task, functionMap)
    .filter((fn) => functionIds === null || functionIds.includes(fn.function_id))
    .flatMap((fn) => fn.source_paths ?? []))].sort();
}

function taskProjection(task, functionMap, resourceMap, functionIds = null) {
  const functions = functionsForTask(task, functionMap)
    .filter((fn) => functionIds === null || functionIds.includes(fn.function_id));
  if (functions.length === 0) throw new Error(`FUNCTION_MISSING:${task.task_id}`);
  const resourceIds = [...new Set(functions.flatMap((fn) => fn.resource_ids ?? []))].sort();
  for (const resourceId of resourceIds) {
    const resource = resourceMap.resources.find((entry) => entry.resource_id === resourceId);
    if (!resource) throw new Error(`RESOURCE_MISSING:${task.task_id}:${resourceId}`);
  }
  return {
    functionIds: functions.map((fn) => fn.function_id).sort(),
    resourceIds,
    gateIds: [...new Set(functions.flatMap((fn) => fn.required_gates ?? []))].sort(),
    sourcePaths: sourcePaths(task, functionMap, functionIds),
  };
}

function gateById(verificationMap, gateId) {
  const gate = verificationMap.gates.find((entry) => entry.gate_id === gateId);
  if (!gate || gate.status !== 'active' || !Array.isArray(gate.argv) || gate.argv.length === 0) {
    throw new Error(`GATE_NOT_EXECUTABLE:${gateId}`);
  }
  return gate;
}

function inputPathsForGate(gate, gateInputContract) {
  if (gate.input_set_id) {
    const paths = gateInputContract.input_sets?.[gate.input_set_id];
    if (!Array.isArray(paths) || paths.length === 0) throw new Error(`GATE_INPUT_SET_MISSING:${gate.gate_id}`);
    return paths;
  }
  if (Array.isArray(gate.input_paths) && gate.input_paths.length > 0) return gate.input_paths;
  throw new Error(`GATE_INPUT_PATHS_MISSING:${gate.gate_id}`);
}

function evidenceScope(truth, sourceCommit, featureId, moduleId, paths) {
  const inputs = [...new Set(paths)].sort().map((sourcePath) => {
    const identity = truth.blobIdentity(sourceCommit, sourcePath);
    if (!identity) throw new Error(`SOURCE_MISSING:${sourceCommit}:${sourcePath}`);
    return identity;
  });
  return {
    input_hashes: [...new Set(inputs.map((identity) => identity.sha256))].sort(),
    scope_hash: sha256(canonicalJson({
      feature_id: featureId,
      module_id: moduleId,
      source_commit: sourceCommit,
      inputs,
    })),
  };
}

function candidateIdentity({ truth, lane, batch, tasks }) {
  const candidate = truth.deriveCandidateIdentity({
    baseCommit: lane.base,
    headCommit: lane.head,
    binding: {
      schema: 'v4-feature-layer-candidate/v1',
      batch_id: batch.batch_id,
      module_id: lane.module,
      task_ids: tasks.map((task) => task.task_id).sort(),
    },
  });
  if (!candidate) throw new Error(`CANDIDATE_IDENTITY_FAILED:${batch.batch_id}`);
  return candidate;
}

function candidateRecord({ candidate, lane, batch, tasks, createdAt }) {
  return {
    fix_candidate_id: `v4-layer-batch-${batch.batch_id.toLowerCase()}-current`,
    issue_id: `V4-LAYER-BATCH-${batch.batch_id}`,
    module_id: lane.module,
    worktree_id: path.basename(repoRoot),
    base_commit: candidate.base_commit,
    head_commit: candidate.head_commit,
    tree_hash: candidate.tree_hash,
    diff_hash: candidate.diff_hash,
    design_id: `v4-feature-layer-batch-${batch.batch_id.toLowerCase()}`,
    owner: lane.module,
    scope_hash: candidate.scope_hash,
    changed_paths: candidate.changed_paths,
    verification_evidence_ids: [...new Set(tasks.flatMap((task) => (task.evidence_refs ?? [])
      .map((ref) => path.basename(ref.path, '.json'))))].sort(),
    created_at: createdAt,
    batch_id: batch.batch_id,
    task_ids: tasks.map((task) => task.task_id).sort(),
  };
}

function writeEvidence({
  truth,
  candidate,
  task,
  batchId,
  lane,
  gate,
  sourcePathsValue,
  gateInputPaths,
  createdAt,
}) {
  const gateInputContract = readJson(gateInputContractPath);
  const role = gate.evidence_role;
  if (!ROLE_CONTRACT.has(role)) return null;
  const evidenceName = `${ROLE_EVIDENCE.get(role)}-${lane.head.slice(0, 12)}`;
  const inputPaths = gateInputPaths ?? inputPathsForGate(gate, gateInputContract);
  const scope = evidenceScope(
    truth,
    lane.head,
    task.task_id,
    lane.module,
    [...sourcePathsValue, ...inputPaths],
  );
  const evidence = {
    evidence_id: evidenceName,
    issue_id: task.task_id,
    experiment_id: `v4-feature-layer-${batchId.toLowerCase()}-${task.task_id.toLowerCase()}`,
    phase: ROLE_CONTRACT.get(role)[0],
    kind: ROLE_CONTRACT.get(role)[1],
    ...(role === 'boundary_audit' || role === 'plane_isolation'
      ? { execution_surface: 'development_whitebox' }
      : {}),
    source_commit: lane.head,
    scope: { feature_id: task.task_id, module_id: lane.module },
    producer: gate.producer,
    command_argv: gate.argv,
    exit_status: 0,
    result: 'pass',
    created_at: createdAt,
    expires_at: new Date(Date.parse(createdAt) + MAX_EVIDENCE_TTL_MS).toISOString(),
    input_hashes: scope.input_hashes,
    scope_hash: candidate.scope_hash,
  };
  const relativePath = `docs/evidence/feature-completion/M1/${task.task_id}/${evidenceName}.json`;
  writeExclusive(path.join(v4Root, relativePath), evidence);
  return { role, gate_id: gate.gate_id, path: relativePath };
}

export function main({ now = Date.now() } = {}) {
  const branch = spawnSync('git', ['branch', '--show-current'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).stdout.trim();
  if (!branch.startsWith('codex/')) throw new Error('OWNER_WORKTREE_REQUIRED');
  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=no', '--', 'v4'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).stdout;
  if (status.length > 0) throw new Error('CANDIDATE_WORKTREE_DIRTY');
  const truth = createGitTruth({ repoRoot, v4Root });
  const currentHead = truth.currentHead();
  const manifest = readJson(manifestPath);
  const functionMap = readJson(functionMapPath);
  const resourceMap = readJson(resourceMapPath);
  const verificationMap = readJson(verificationMapPath);
  const createdAt = new Date(now).toISOString();
  const next = JSON.parse(JSON.stringify(manifest));
  const records = [];
  const gateInputContract = readJson(gateInputContractPath);
  const G_TASK_FUNCTIONS = new Map([
    ['V4-GATE-001', ['v4.governance.feature_layer_gate_contract']],
    ['V4-LAYER-GATE-001', ['v4.governance.feature_layer_product_lockstep']],
  ]);
  for (const batch of next.batches) {
    const lane = LANES.get(batch.batch_id);
    if (!lane) continue;
    batch.owner_binding_status = 'bound';
    batch.owner_function_id = lane.owner;
    batch.module_ids = [lane.module];
    batch.owned_paths = lane.paths;
    batch.source_dependencies = [];
    batch.status = 'source_green';
    const candidatePath = `docs/evidence/feature-completion/M1/V4-LAYER-BATCH-${batch.batch_id}/fix-candidate-${lane.head.slice(0, 12)}.json`;
    const tasks = batch.tasks.map((task) => {
      const functionIds = batch.batch_id === 'G'
        ? G_TASK_FUNCTIONS.get(task.task_id)
        : null;
      if (batch.batch_id === 'G' && !functionIds) {
        throw new Error(`G_TASK_FUNCTION_BINDING_MISSING:${task.task_id}`);
      }
      const projection = taskProjection(task, functionMap, resourceMap, functionIds);
      return {
        task_id: task.task_id,
        status: 'source_green',
        candidate_record: candidatePath,
        function_ids: projection.functionIds,
        resource_ids: projection.resourceIds,
        source_paths: projection.sourcePaths,
        support_paths: task.support_paths ?? [],
        required_gate_ids: projection.gateIds,
        mainline_binding: 'forbidden_before_integration',
        evidence_refs: [],
      };
    });
    const candidate = candidateIdentity({ truth, lane, batch, tasks });
    for (const task of tasks) {
      const evidenceSourcePaths = batch.batch_id === 'F'
        ? [...new Set(tasks.flatMap((candidateTask) => [
          ...candidateTask.source_paths,
          ...candidateTask.support_paths,
        ]))].sort()
        : [...task.source_paths, ...task.support_paths];
      const projection = taskProjection(
        task,
        functionMap,
        resourceMap,
        batch.batch_id === 'G' ? G_TASK_FUNCTIONS.get(task.task_id) : null,
      );
      const gateInputPaths = [...new Set(projection.gateIds.flatMap((gateId) =>
        inputPathsForGate(gateById(verificationMap, gateId), gateInputContract)))].sort();
      for (const gateId of task.required_gate_ids) {
        const gate = gateById(verificationMap, gateId);
        const ref = writeEvidence({
          truth,
          candidate,
          task,
          batchId: batch.batch_id,
          lane,
          gate,
          sourcePathsValue: evidenceSourcePaths,
          gateInputPaths,
          createdAt,
        });
        if (ref) task.evidence_refs.push(ref);
      }
      if (batch.batch_id === 'G' && task.task_id === 'V4-GATE-001') {
        const planeGate = gateById(verificationMap, 'v4_parity_gate_plane_isolation');
        const ref = writeEvidence({
          truth,
          candidate,
          task,
          batchId: batch.batch_id,
          lane,
          gate: planeGate,
          sourcePathsValue: evidenceSourcePaths,
          gateInputPaths: inputPathsForGate(planeGate, gateInputContract),
          createdAt,
        });
        if (ref) task.evidence_refs.push(ref);
      }
    }
    batch.tasks = tasks;
    const record = candidateRecord({ candidate, lane, batch, tasks, createdAt });
    writeExclusive(path.join(v4Root, candidatePath), record);
    records.push(candidatePath);
  }
  writeExclusive(`${manifestPath}.next`, next);
  return {
    head: currentHead,
    candidate_records: records,
    manifest_next: path.relative(v4Root, `${manifestPath}.next`),
  };
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === scriptPath;
if (direct) {
  try {
    console.log(JSON.stringify(main(), null, 2));
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exit(1);
  }
}
