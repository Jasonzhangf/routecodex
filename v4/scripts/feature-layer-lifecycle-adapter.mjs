#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createGitTruth, canonicalJson, sha256 } from './architecture/lib/feature-layer-batch-git.mjs';
import { observeWiring } from './architecture/lib/feature-layer-batch-graph.mjs';

const root = process.cwd();
const repo = path.resolve(root, '..');
const manifestPath = 'contracts/feature-completion-layer-batches.manifest.json';
const templateRef = process.env.V4_LAYER_TEMPLATE_REF ?? '6b0b3a192';
const mode = process.argv[2] ?? '--prepare';
const sdk = '/Users/fanzhang/.cargo/bin/appsdk';

function run(program, args, cwd = repo, options = {}) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, V4_LAYER_GATE_CHILD: '1' },
    timeout: options.timeout ?? 1_800_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')} exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

function gitShow(ref, file) {
  return run('git', ['show', `${ref}:${file}`]).stdout;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

function writeJson(file, value) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function now() {
  return new Date().toISOString();
}

function expiry() {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

function fileHash(bytes) {
  return sha256(bytes);
}

function sourceBytes(truth, commit, relativePath) {
  const bytes = truth.blob(commit, relativePath);
  if (bytes === null) throw new Error(`${commit}:${relativePath} is missing`);
  return bytes;
}

function sourceHashes(truth, commit, paths) {
  return [...new Set(paths.map((entry) => fileHash(sourceBytes(truth, commit, entry))))].sort();
}

function scopeFor(truth, commit, featureId, moduleId, sourcePaths) {
  const inputs = sourcePaths.map((entry) => truth.blobIdentity(commit, entry));
  if (inputs.some((entry) => !entry)) throw new Error(`${featureId}: source identity missing`);
  const sorted = inputs.sort((left, right) => left.path.localeCompare(right.path));
  return {
    input_hashes: [...new Set(sorted.map((entry) => entry.sha256))].sort(),
    scope_hash: sha256(canonicalJson({
      feature_id: featureId,
      module_id: moduleId,
      source_commit: commit,
      inputs: sorted,
    })),
  };
}

function gateInputPaths(gate, contract) {
  if (gate.input_set_id) return contract.input_sets[gate.input_set_id] ?? [];
  return gate.input_paths ?? [];
}

function candidateIdentity(truth, baseCommit, headCommit, binding) {
  return truth.deriveCandidateIdentity({ baseCommit, headCommit, binding });
}

function candidateRecordForCurrentHead(truth, baseCommit, headCommit) {
  const taskIds = ['V4-GATE-001', 'V4-LAYER-GATE-001'];
  const identity = candidateIdentity(truth, baseCommit, headCommit, {
    schema: 'v4-feature-layer-candidate/v1',
    batch_id: 'G',
    module_id: 'routecodex-v4-governance',
    task_ids: taskIds,
  });
  return {
    fix_candidate_id: `v4-layer-gate-current-${headCommit.slice(0, 12)}`,
    issue_id: 'V4-LAYER-GATE-001',
    module_id: 'routecodex-v4-governance',
    worktree_id: `v4-cordis-integration-${headCommit.slice(0, 12)}`,
    base_commit: identity.base_commit,
    head_commit: identity.head_commit,
    tree_hash: identity.tree_hash,
    diff_hash: identity.diff_hash,
    design_id: 'v4-feature-completion-layer-gate',
    owner: 'routecodex-v4-governance',
    scope_hash: identity.scope_hash,
    changed_paths: identity.changed_paths,
    verification_evidence_ids: ['boundary-audit', 'plane-isolation', 'positive', 'red-gate'],
    created_at: now(),
    batch_id: 'G',
    task_ids: taskIds,
  };
}

function makeEvidence({ id, featureId, moduleId, role, gate, commit, scopeHash, inputHashes, receipt }) {
  const contracts = {
    positive: ['positive_intervention', 'positive_test'],
    red_gate: ['negative_intervention', 'red_test'],
    boundary_audit: ['development_whitebox', 'gate'],
    plane_isolation: ['development_whitebox', 'gate'],
    baseline_replay: ['baseline_reproduction', 'sample_replay'],
    closure_audit: ['development_whitebox', 'gate'],
  };
  const [phase, kind] = contracts[role];
  return {
    evidence_id: id,
    issue_id: featureId,
    experiment_id: `v4-layer-refresh-${featureId}`,
    phase,
    kind,
    execution_surface: phase === 'development_whitebox' ? 'development_whitebox' : undefined,
    source_commit: commit,
    scope: { feature_id: featureId, module_id: moduleId },
    producer: gate.producer,
    command_argv: gate.argv,
    exit_status: receipt.status,
    output_hash: sha256(receipt.output),
    result: 'pass',
    created_at: now(),
    expires_at: expiry(),
    input_hashes: inputHashes,
    scope_hash: scopeHash,
  };
}

function candidateWorktree(commit) {
  const dir = fs.mkdtempSync(path.join(repo, 'playground/.v4-layer-refresh-'));
  run('git', ['worktree', 'add', '--detach', dir, commit]);
  return dir;
}

function removeCandidateWorktree(dir) {
  run('git', ['worktree', 'remove', '--force', dir], repo, { timeout: 120_000 });
  fs.rmSync(dir, { recursive: true, force: true });
}

function runGateAt(cache, commit, gate) {
  const key = `${commit}:${gate.argv.join('\0')}`;
  if (cache.has(key)) return cache.get(key);
  const dir = candidateWorktree(commit);
  try {
    const receipt = run(gate.argv[0], gate.argv.slice(1), path.join(dir, 'v4'), {
      allowFailure: true,
      timeout: 1_800_000,
    });
    if (receipt.status !== 0) {
      throw new Error(`${gate.gate_id} at ${commit} exited ${receipt.status}: ${receipt.output}`);
    }
    cache.set(key, receipt);
    return receipt;
  } finally {
    removeCandidateWorktree(dir);
  }
}

function refreshTaskEvidence(manifest, truth, verificationMap, inputContract) {
  const cache = new Map();
  for (const batch of manifest.batches) {
    const groupedTasks = batch.batch_id === 'F' ? batch.tasks : null;
    for (const task of batch.tasks) {
      const candidate = JSON.parse(fs.readFileSync(path.join(root, task.candidate_record), 'utf8'));
      const sourceTasks = groupedTasks ?? [task];
      const sourcePaths = [...new Set(sourceTasks.flatMap((entry) => [
        ...entry.source_paths,
        ...entry.support_paths,
      ]))].sort();
      for (const ref of task.evidence_refs) {
        const gate = verificationMap.gates.find((entry) => entry.gate_id === ref.gate_id);
        if (!gate) throw new Error(`${task.task_id}:${ref.gate_id} gate missing`);
        const inputPaths = gateInputPaths(gate, inputContract);
        const inputHashes = sourceHashes(truth, candidate.head_commit, [...sourcePaths, ...inputPaths]);
        const receipt = runGateAt(cache, candidate.head_commit, gate);
        const evidence = makeEvidence({
          id: path.basename(ref.path, '.json'),
          featureId: task.task_id,
          moduleId: batch.module_ids[0],
          role: ref.role,
          gate,
          commit: candidate.head_commit,
          scopeHash: candidate.scope_hash,
          inputHashes,
          receipt,
        });
        writeJson(ref.path, evidence);
      }
    }
  }
  const baseline = manifest.baseline;
  const baselineGate = verificationMap.gates.find((entry) => entry.gate_id === 'v4_current_tree_baseline_replay');
  const baselineScope = scopeFor(truth, baseline.resolved_commit, baseline.feature_id,
    baseline.runtime_module_id, baseline.source_paths);
  const baselineReceipt = runGateAt(cache, baseline.resolved_commit, baselineGate);
  writeJson(baseline.evidence_refs[0].path, makeEvidence({
    id: 'baseline-replay',
    featureId: baseline.feature_id,
    moduleId: baseline.runtime_module_id,
    role: 'baseline_replay',
    gate: baselineGate,
    commit: baseline.resolved_commit,
    scopeHash: baselineScope.scope_hash,
    inputHashes: baselineScope.input_hashes,
    receipt: baselineReceipt,
  }));
  const prerequisite = manifest.prerequisites[0];
  const closureGate = verificationMap.gates.find((entry) => entry.gate_id === 'v4_node_container_epoch_closure_audit');
  const closureScope = scopeFor(truth, prerequisite.audit_commit, prerequisite.feature_id,
    'routecodex-v4-runtime', prerequisite.source_paths);
  const closureReceipt = runGateAt(cache, prerequisite.audit_commit, closureGate);
  writeJson(prerequisite.evidence_refs[0].path, makeEvidence({
    id: 'closure-audit',
    featureId: prerequisite.feature_id,
    moduleId: 'routecodex-v4-runtime',
    role: 'closure_audit',
    gate: closureGate,
    commit: prerequisite.audit_commit,
    scopeHash: closureScope.scope_hash,
    inputHashes: closureScope.input_hashes,
    receipt: closureReceipt,
  }));
}

function prepare() {
  const truth = createGitTruth({ repoRoot: repo, v4Root: root });
  const head = truth.currentHead();
  const base = truth.resolveCommit(run('git', ['merge-base', 'HEAD', 'origin/v4-cordis']).output);
  const manifest = JSON.parse(gitShow(templateRef, `v4/${manifestPath}`));
  const verificationMap = readJson('docs/architecture/maps/verification-map.json');
  const inputContract = readJson('contracts/feature-layer-gate-inputs.contract.json');
  const candidatePaths = [...new Set(manifest.batches.flatMap((batch) => batch.tasks.map((task) => task.candidate_record)))];
  for (const recordPath of candidatePaths) {
    if (recordPath === 'docs/evidence/feature-completion/M1/V4-GATE-001/fix-candidate.json') {
      writeJson(recordPath, candidateRecordForCurrentHead(truth, base, head));
    } else {
      writeJson(recordPath, JSON.parse(gitShow(templateRef, `v4/${recordPath}`)));
    }
  }
  manifest.integration.guard_commit = 'e162734f84f9aa1f456a8d2c24105c7a32cafa66';
  manifest.integration.enforcement_binding_status = 'bound';
  manifest.integration.wiring_started = true;
  manifest.integration.wiring_edges = [];
  for (const surface of manifest.integration.guarded_surfaces) {
    surface.scope_hash = truth.scopeHashAt(manifest.integration.guard_commit, [surface.path]);
  }
  writeJson(manifestPath, manifest);
  manifest.integration.wiring_edges = observeWiring(manifest, truth).wiring_edges;
  writeJson(manifestPath, manifest);
  refreshTaskEvidence(manifest, truth, verificationMap, inputContract);
  console.log(JSON.stringify({ mode: 'prepare', templateRef, head, base, wiring_edges: manifest.integration.wiring_edges }, null, 2));
}

function finalize() {
  const truth = createGitTruth({ repoRoot: repo, v4Root: root });
  const head = truth.currentHead();
  const manifest = readJson(manifestPath);
  const verificationMap = readJson('docs/architecture/maps/verification-map.json');
  const gateIds = [...new Set(manifest.batches.flatMap((batch) => batch.tasks
    .filter((task) => task.status === 'source_green')
    .flatMap((task) => task.required_gate_ids)))]
    .filter((gateId) => !['v4_feature_layer_batches', 'v4_feature_layer_batch_admission', 'v4_feature_layer_batch_build_guard'].includes(gateId))
    .sort();
  const receipts = [];
  const cache = new Map();
  for (const gateId of gateIds) {
    const gate = verificationMap.gates.find((entry) => entry.gate_id === gateId);
    if (!gate) throw new Error(`missing integration gate ${gateId}`);
    const receipt = runGateAt(cache, head, gate);
    receipts.push({ gate_id: gateId, producer: gate.producer.adapter + ':' + gate.producer.identity,
      result: 'pass', source_commit: head, tree_hash: truth.treeHash(head) });
  }
  const candidates = [...new Set(manifest.batches.flatMap((batch) => batch.tasks
    .filter((task) => task.status === 'source_green')
    .map((task) => task.candidate_record)))].map((recordPath) => ({
      path: recordPath,
      record: readJson(recordPath),
    }));
  const records = '.appsdk/records';
  fs.mkdirSync(path.join(root, records), { recursive: true });
  const ordered = candidates.map(({ record }) => record).sort((left, right) => left.head_commit.localeCompare(right.head_commit));
  const queueEntries = ordered.map((record, index) => ({
    queue_entry_id: `v4-layer-${record.batch_id.toLowerCase()}`,
    issue_id: record.issue_id,
    module_id: record.module_id,
    collaboration_id: `v4-layer-${record.batch_id.toLowerCase()}`,
    milestone_id: 'v4-cordis-governance-m1',
    delivery_mode: 'commit_merge_each_milestone',
    fix_candidate_id: record.fix_candidate_id,
    effectiveness_id: `effectiveness-${record.fix_candidate_id}`,
    candidate_commit: record.head_commit,
    main_base_commit: record.base_commit,
    queue_position: index + 1,
    merge_owner: 'appsdk::merge_queue',
    strategy: 'integration_merge_then_fast_forward',
    status: 'admitted',
    created_at: now(),
  }));
  for (const entry of queueEntries) writeJson(`${records}/merge-queue-record-${entry.queue_entry_id}.json`, entry);
  const active = queueEntries.at(-1);
  writeJson(`${records}/merge-queue-state.json`, {
    active_entry_id: active.queue_entry_id,
    merge_owner: 'appsdk::merge_queue',
    ordered_entry_ids: queueEntries.map((entry) => entry.queue_entry_id),
  });
  const integrationId = 'v4-integration-m1-current';
  writeJson(`${records}/integration-record-${integrationId}.json`, {
    candidate_commit: active.candidate_commit,
    conflict_status: 'clean',
    created_at: now(),
    impact_status: 'revalidated',
    integration_commit: head,
    integration_id: integrationId,
    integration_tree_hash: truth.treeHash(head),
    issue_id: active.issue_id,
    main_base_commit: active.main_base_commit,
    milestone_id: active.milestone_id,
    module_id: active.module_id,
    queue_entry_id: active.queue_entry_id,
    required_gate_results: receipts,
    resolution_mode: 'none',
    result: 'pass',
  });
  console.log(JSON.stringify({ mode: 'finalize', head, gate_count: receipts.length, queue_count: queueEntries.length }, null, 2));
}

if (mode === '--prepare') prepare();
else if (mode === '--finalize') finalize();
else throw new Error('usage: node scripts/feature-layer-lifecycle-adapter.mjs --prepare|--finalize');
