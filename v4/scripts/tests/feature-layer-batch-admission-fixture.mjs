import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXPECTED_TASKS, RUNTIME_MODULE_ID } from '../architecture/lib/feature-layer-batch-contract.mjs';
import { GATE_INPUT_SETS } from '../architecture/lib/feature-layer-batch-registry.mjs';
import { canonicalJson, createGitTruth, sha256 } from '../architecture/lib/feature-layer-batch-git.mjs';

const v4Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE_ANCHOR = '7557b8825ac829a436193ddf865568c9091eda5b';
const ROLE_GATES = [
  ['fixture_positive', 'positive', 'positive_test', 'positive_intervention'],
  ['fixture_red', 'red_gate', 'red_test', 'negative_intervention'],
  ['fixture_boundary', 'boundary_audit', 'gate', 'development_whitebox'],
  ['fixture_plane', 'plane_isolation', 'gate', 'development_whitebox'],
];
const GUARD_SURFACES = [
  'scripts/build.mjs',
  'scripts/verify.mjs',
  'scripts/verify-ci.mjs',
  'scripts/install-rccv4.mjs',
  'scripts/compile-real-runtime-manifest.mjs',
];
const GUARD_REMOVALS = new Map([
  ['scripts/build.mjs', "run('node scripts/architecture/verify-v4-feature-layer-batches.mjs --build-guard');\n// V4-LAYER-PREFLIGHT-END\n"],
  ['scripts/verify.mjs', "run('node scripts/architecture/verify-v4-feature-layer-batches.mjs --build-guard');\n// V4-LAYER-PREFLIGHT-END\n"],
  ['scripts/verify-ci.mjs', "run('node scripts/architecture/verify-v4-feature-layer-batches.mjs --build-guard');\n// V4-LAYER-PREFLIGHT-END\n"],
  ['scripts/install-rccv4.mjs', "const admission = spawnSync(process.execPath, [\n  'scripts/architecture/verify-v4-feature-layer-batches.mjs',\n  '--admission',\n], { cwd: root, encoding: 'utf8' });\nif (admission.status !== 0) {\n  throw new Error(`V4 feature-layer admission failed: ${admission.stderr || admission.stdout}`);\n}\n// V4-LAYER-PREFLIGHT-END\n"],
  ['scripts/compile-real-runtime-manifest.mjs', [
    "import { spawnSync } from 'node:child_process';\n",
    "const admission = spawnSync(process.execPath, [\n  'scripts/architecture/verify-v4-feature-layer-batches.mjs',\n  '--admission',\n], { cwd: root, encoding: 'utf8' });\nif (admission.status !== 0) {\n  throw new Error(`V4 feature-layer admission failed: ${admission.stderr || admission.stdout}`);\n}\n// V4-LAYER-PREFLIGHT-END\n",
  ]],
]);

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function run(repo, command, args) {
  const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
  return result.stdout.trim();
}
function write(repo, relativePath, value) {
  const file = path.join(repo, 'v4', relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.isBuffer(value) ? value : String(value));
}
function commit(repo, message) {
  run(repo, 'git', ['add', '--all']);
  run(repo, 'git', ['commit', '-m', message]);
  return run(repo, 'git', ['rev-parse', 'HEAD']);
}
function taskSymbol(taskId) {
  return taskId.replace(/[^A-Za-z0-9]/g, '_');
}
function taskFunctionId(taskId) { return `fixture.function.${taskId.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`; }
function taskResourceId(taskId) { return `fixture.resource.${taskId.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`; }
function scopeFor(truth, sourceCommit, featureId, moduleId, sourcePaths) {
  const inputs = sourcePaths.map((sourcePath) => truth.blobIdentity(sourceCommit, sourcePath));
  const sorted = inputs.sort((left, right) => left.path.localeCompare(right.path));
  return {
    input_hashes: [...new Set(sorted.map((item) => item.sha256))].sort(),
    scope_hash: sha256(canonicalJson({ feature_id: featureId, module_id: moduleId, source_commit: sourceCommit, inputs: sorted })),
  };
}
function evidenceRecord({ id, taskId, moduleId, sourceCommit, scopeHash, inputHashes, gateId, argv, producer, phase, kind, now }) {
  const created = new Date(now).toISOString();
  const expires = new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString();
  const whitebox = phase === 'development_whitebox' ? { execution_surface: 'development_whitebox' } : {};
  return {
    evidence_id: id,
    issue_id: taskId,
    experiment_id: `fixture-${taskId.toLowerCase()}`,
    phase,
    kind,
    source_commit: sourceCommit,
    scope: { feature_id: taskId, module_id: moduleId },
    producer,
    command_argv: argv,
    exit_status: 0,
    result: 'pass',
    created_at: created,
    expires_at: expires,
    input_hashes: inputHashes,
    scope_hash: scopeHash,
    ...whitebox,
  };
}

/**
 * Exercises the real admission validator against a committed, all-ready
 * temporary Git repository.  This is test-only: it never changes production
 * manifests, bypasses a gate, or substitutes a fake runGate implementation.
 */
export function runAllReadyAdmissionFixture({ canonicalInput, validate, now = Date.now() }) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-layer-admission-ready-'));
  try {
    run(repo, 'git', ['init', '--quiet']);
    run(repo, 'git', ['config', 'user.name', 'V4 Admission Fixture']);
    run(repo, 'git', ['config', 'user.email', 'v4-admission@example.invalid']);
    const input = clone(canonicalInput);
    const taskDescriptors = [];
    for (const [batchId, taskIds] of EXPECTED_TASKS) {
      const moduleId = batchId === 'G' ? 'routecodex-v4-governance' : `fixture-module-${batchId}`;
      if (batchId === 'G') {
        input.moduleRegistry.modules.find((module) => module.module_id === moduleId)
          ?.owned_paths.push('fixture/G/**');
      } else {
        input.moduleRegistry.modules.push({
          module_id: moduleId,
          status: 'active',
          owner: moduleId,
          owned_paths: [`fixture/${batchId}/**`],
          forbidden_paths: ['active/lib/**', 'protected/**', 'generated/**'],
          verification_gates: ROLE_GATES.map(([gateId]) => gateId),
        });
      }
      for (const taskId of taskIds) {
        const symbol = taskSymbol(taskId);
        const sourcePath = `fixture/${batchId}/${symbol}.mjs`;
        const functionId = taskFunctionId(taskId);
        const resourceId = taskResourceId(taskId);
        taskDescriptors.push({ batchId, taskId, moduleId, symbol, sourcePath, functionId, resourceId });
        input.functionMap.functions.push({
          function_id: functionId,
          owner: moduleId,
          status: 'active',
          feature_id: taskId,
          entry_symbols: [symbol],
          source_paths: batchId === 'G' && taskId === 'V4-LAYER-GATE-001'
            ? [sourcePath, ...GUARD_SURFACES]
            : [sourcePath],
          resource_ids: [resourceId],
          required_gates: ROLE_GATES.map(([gateId]) => `fixture_${gateId}`),
        });
        input.resourceMap.resources.push({
          resource_id: resourceId,
          owner: moduleId,
          truth_store: sourcePath,
          allowed_operations: ['read'],
          status: 'active',
          feature_id: taskId,
        });
      }
    }
    const allTaskIds = taskDescriptors.map((entry) => entry.taskId);
    for (const [suffix, role] of ROLE_GATES) {
      const gateId = `fixture_${suffix}`;
      input.verificationMap.gates.push({
        gate_id: gateId,
        status: 'active',
        command: 'node fixture/gate.mjs',
        argv: ['node', 'fixture/gate.mjs'],
        owner_module_id: 'routecodex-v4-governance',
        feature_ids: allTaskIds,
        evidence_role: role,
        producer: { adapter: 'node', identity: gateId },
        input_paths: ['fixture/gate.mjs'],
        required_for: ['source_green'],
      });
    }
    for (const relativePath of GATE_INPUT_SETS.layer) {
      const source = path.join(v4Root, relativePath);
      write(repo, relativePath, fs.existsSync(source) ? fs.readFileSync(source) : '');
    }
    for (const [relativePath, removals] of GUARD_REMOVALS) {
      const file = path.join(repo, 'v4', relativePath);
      let source = fs.readFileSync(file, 'utf8');
      for (const removal of (Array.isArray(removals) ? removals : [removals])) source = source.replace(removal, '');
      write(repo, relativePath, source);
    }
    write(repo, 'fixture/gate.mjs', 'process.exit(0);\n');
    write(repo, 'scripts/_common.mjs', fs.readFileSync(path.join(v4Root, 'scripts/_common.mjs')));
    write(repo, 'crates/routecodex-v4-runtime/src/lib.rs', 'pub fn baseline_runtime() {}\n');
    write(repo, 'docs/architecture/maps/function-map.json', JSON.stringify(input.functionMap, null, 2));
    write(repo, 'docs/architecture/maps/resource-map.json', JSON.stringify(input.resourceMap, null, 2));
    write(repo, 'docs/architecture/maps/verification-map.json', JSON.stringify(input.verificationMap, null, 2));
    write(repo, '.appsdk/maps/module-registry.json', JSON.stringify(input.moduleRegistry, null, 2));
    const base = commit(repo, 'fixture baseline');
    run(repo, 'git', ['tag', BASELINE_ANCHOR, base]);
    const rawTruth = createGitTruth({ repoRoot: repo, v4Root: path.join(repo, 'v4') });
    const truth = {
      ...rawTruth,
      resolveCommit(ref) {
        return ref === BASELINE_ANCHOR ? base : rawTruth.resolveCommit(ref);
      },
    };
    const candidates = new Map();
    for (const batchId of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) {
      const entries = taskDescriptors.filter((entry) => entry.batchId === batchId);
      for (const entry of entries) write(repo, entry.sourcePath, `export function ${entry.symbol}() { return true; }\n`);
      if (batchId === 'G') {
        for (const relativePath of GUARD_SURFACES) {
          const source = path.join(v4Root, relativePath);
          write(repo, relativePath, fs.readFileSync(source));
        }
      }
      const head = commit(repo, `fixture candidate ${batchId}`);
      candidates.set(batchId, truth.deriveCandidateIdentity({
        baseCommit: batchId === 'A' ? base : candidates.get(String.fromCharCode(batchId.charCodeAt(0) - 1))?.head_commit,
        headCommit: head,
        binding: {
          schema: 'v4-feature-layer-candidate/v1',
          batch_id: batchId,
          module_id: batchId === 'G' ? 'routecodex-v4-governance' : `fixture-module-${batchId}`,
          task_ids: entries.map((entry) => entry.taskId).sort(),
        },
      }));
    }
    const manifest = input.manifest;
    for (const batch of manifest.batches) {
      const entries = taskDescriptors.filter((entry) => entry.batchId === batch.batch_id);
      batch.owner_binding_status = 'bound';
      batch.owner_function_id = entries[0].functionId;
      batch.module_ids = [batch.batch_id === 'G' ? 'routecodex-v4-governance' : `fixture-module-${batch.batch_id}`];
      batch.owned_paths = [`fixture/${batch.batch_id}/**`];
      batch.status = 'source_green';
      for (const task of batch.tasks) {
        const entry = entries.find((candidate) => candidate.taskId === task.task_id);
        const candidate = candidates.get(batch.batch_id);
        task.status = 'source_green';
        task.candidate_record = `docs/evidence/feature-completion/M1/V4-LAYER-BATCH-${batch.batch_id}/fix-candidate.json`;
        task.function_ids = [entry.functionId];
        task.resource_ids = [entry.resourceId];
        task.source_paths = batch.batch_id === 'G' && task.task_id === 'V4-LAYER-GATE-001'
          ? [entry.sourcePath, ...GUARD_SURFACES]
          : [entry.sourcePath];
        task.support_paths = [];
        task.required_gate_ids = ROLE_GATES.map(([suffix]) => `fixture_${suffix}`);
        task.evidence_refs = ROLE_GATES.map(([suffix, role]) => ({
          role,
          gate_id: `fixture_${suffix}`,
          path: `docs/evidence/feature-completion/M1/${task.task_id}/${role}.json`,
        }));
        const evidenceDir = `docs/evidence/feature-completion/M1/${task.task_id}`;
        const inputHashes = [...new Set([
          ...task.source_paths.map((sourcePath) => truth.blobIdentity(candidate.head_commit, sourcePath).sha256),
          truth.blobIdentity(candidate.head_commit, 'fixture/gate.mjs').sha256,
        ])].sort();
        const scope = candidate.scope_hash;
        for (const [suffix, role, kind, phase] of ROLE_GATES) {
          write(repo, `${evidenceDir}/${role}.json`, JSON.stringify(evidenceRecord({
            id: role,
            taskId: task.task_id,
            moduleId: batch.module_ids[0],
            sourceCommit: candidate.head_commit,
            scopeHash: scope,
            inputHashes,
            gateId: `fixture_${suffix}`,
            argv: ['node', 'fixture/gate.mjs'],
            producer: { adapter: 'node', identity: `fixture_${suffix}` },
            phase,
            kind,
            now,
          }), null, 2));
        }
      }
    }
    const hEntry = taskDescriptors.find((entry) => entry.taskId === 'V4-RUNTIME-002');
    const hCandidate = candidates.get('H');
    manifest.baseline.required_commit = BASELINE_ANCHOR;
    manifest.baseline.resolved_commit = base;
    manifest.baseline.source_paths = ['crates/routecodex-v4-runtime/src/lib.rs'];
    manifest.baseline.evidence_refs = [{ role: 'baseline_replay', gate_id: 'fixture_baseline_replay', path: 'docs/evidence/feature-completion/M1/V4-CURRENT-TREE/baseline_replay.json' }];
    manifest.prerequisites[0] = {
      feature_id: 'V4-RUNTIME-002',
      status: 'pass',
      gap_detected: true,
      epoch_closure_lane_status: 'source_green',
      audit_commit: hCandidate.head_commit,
      source_paths: [hEntry.sourcePath],
      evidence_refs: [{ role: 'closure_audit', gate_id: 'fixture_closure_audit', path: 'docs/evidence/feature-completion/M1/V4-RUNTIME-002/closure_audit.json' }],
    };
    const baselineScope = scopeFor(truth, base, 'V4-CURRENT-TREE', RUNTIME_MODULE_ID, manifest.baseline.source_paths);
    write(repo, 'docs/evidence/feature-completion/M1/V4-CURRENT-TREE/baseline_replay.json', JSON.stringify(evidenceRecord({
      id: 'baseline_replay', taskId: 'V4-CURRENT-TREE', moduleId: RUNTIME_MODULE_ID, sourceCommit: base,
      scopeHash: baselineScope.scope_hash, inputHashes: baselineScope.input_hashes,
      gateId: 'fixture_baseline_replay', argv: ['node', 'fixture/gate.mjs'], producer: { adapter: 'node', identity: 'fixture_baseline_replay' },
      phase: 'baseline_reproduction', kind: 'sample_replay', now,
    }), null, 2));
    const closureScope = scopeFor(truth, hCandidate.head_commit, 'V4-RUNTIME-002', RUNTIME_MODULE_ID, [hEntry.sourcePath]);
    write(repo, 'docs/evidence/feature-completion/M1/V4-RUNTIME-002/closure_audit.json', JSON.stringify(evidenceRecord({
      id: 'closure_audit', taskId: 'V4-RUNTIME-002', moduleId: RUNTIME_MODULE_ID, sourceCommit: hCandidate.head_commit,
      scopeHash: closureScope.scope_hash, inputHashes: closureScope.input_hashes,
      gateId: 'fixture_closure_audit', argv: ['node', 'fixture/gate.mjs'], producer: { adapter: 'node', identity: 'fixture_closure_audit' },
      phase: 'development_whitebox', kind: 'gate', now,
    }), null, 2));
    input.verificationMap.gates.push(
      { gate_id: 'fixture_baseline_replay', status: 'active', command: 'node fixture/gate.mjs', argv: ['node', 'fixture/gate.mjs'], owner_module_id: 'routecodex-v4-governance', feature_ids: ['V4-CURRENT-TREE'], evidence_role: 'baseline_replay', producer: { adapter: 'node', identity: 'fixture_baseline_replay' }, input_paths: ['fixture/gate.mjs'], required_for: ['baseline'] },
      { gate_id: 'fixture_closure_audit', status: 'active', command: 'node fixture/gate.mjs', argv: ['node', 'fixture/gate.mjs'], owner_module_id: 'routecodex-v4-governance', feature_ids: ['V4-RUNTIME-002'], evidence_role: 'closure_audit', producer: { adapter: 'node', identity: 'fixture_closure_audit' }, input_paths: ['fixture/gate.mjs'], required_for: ['closure'] },
    );
    for (const [batchId, candidate] of candidates) {
      for (const entry of taskDescriptors.filter((item) => item.batchId === batchId)) {
        const record = {
          fix_candidate_id: `fixture-${batchId.toLowerCase()}-candidate`, issue_id: `V4-LAYER-BATCH-${batchId}`,
          module_id: batchId === 'G' ? 'routecodex-v4-governance' : `fixture-module-${batchId}`, worktree_id: 'fixture', ...candidate,
          design_id: `fixture-${entry.taskId}`, owner: batchId === 'G' ? 'routecodex-v4-governance' : `fixture-module-${batchId}`,
          verification_evidence_ids: ['boundary_audit', 'plane_isolation', 'positive', 'red_gate'].sort(),
          created_at: new Date(now).toISOString(), batch_id: batchId, task_ids: taskDescriptors.filter((item) => item.batchId === batchId).map((item) => item.taskId).sort(),
        };
        delete record.binding;
        delete record.blobs;
        write(repo, `docs/evidence/feature-completion/M1/V4-LAYER-BATCH-${batchId}/fix-candidate.json`, JSON.stringify(record, null, 2));
      }
    }
    const guard = candidates.get('G').head_commit;
    manifest.integration.enforcement_binding_status = 'bound';
    manifest.integration.guard_commit = guard;
    manifest.integration.guarded_surfaces = manifest.integration.guarded_surfaces.map((surface) => ({
      ...surface,
      scope_hash: truth.scopeHashAt(guard, [surface.path]),
    }));
    write(repo, 'contracts/feature-completion-layer-batches.manifest.json', JSON.stringify(manifest, null, 2));
    const gateInput = input.verificationMap.gates;
    input.verificationMap.gates = gateInput;
    write(repo, 'docs/architecture/maps/function-map.json', JSON.stringify(input.functionMap, null, 2));
    write(repo, 'docs/architecture/maps/resource-map.json', JSON.stringify(input.resourceMap, null, 2));
    write(repo, 'docs/architecture/maps/verification-map.json', JSON.stringify(input.verificationMap, null, 2));
    write(repo, '.appsdk/maps/module-registry.json', JSON.stringify(input.moduleRegistry, null, 2));
    const finalHead = commit(repo, 'fixture all-ready evidence');
    const fixtureInput = { ...input, manifest };
    const context = {
      now,
      truth,
      io: {
        readText(relativePath) { return fs.readFileSync(path.join(repo, 'v4', relativePath), 'utf8'); },
        readJson(relativePath) { return JSON.parse(this.readText(relativePath)); },
      },
    };
    const failures = validate(fixtureInput, context, { mode: 'admission' });
    if (failures.length > 0) throw new Error(failures.map((item) => `${item.code}:${item.message}`).join(' | '));
    if (truth.currentHead() !== finalHead || !truth.controlledScopeClean(['v4/**'])) throw new Error('all-ready fixture is not clean at final committed HEAD');
    return true;
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}
