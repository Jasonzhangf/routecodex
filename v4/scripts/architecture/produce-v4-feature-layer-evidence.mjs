#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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

export const BASELINE_FEATURE_ID = 'V4-CURRENT-TREE';
export const RUNTIME_FEATURE_ID = 'V4-RUNTIME-002';
export const RUNTIME_MODULE_ID = 'routecodex-v4-runtime';
export const BASELINE_GATE_ID = 'v4_current_tree_baseline_replay';
export const CLOSURE_GATE_ID = 'v4_node_container_epoch_closure_audit';
export const BASELINE_SOURCE_PATHS = [
  'crates/routecodex-v4-runtime/src/lib.rs',
  'crates/routecodex-v4-node-container/src/lib.rs',
  'crates/routecodex-v4-runtime-bin/src/main.rs',
];
export const RUNTIME_SOURCE_PATHS = [
  'crates/routecodex-v4-node-container/src/lib.rs',
  'crates/routecodex-v4-node-container/tests/l2_epoch.rs',
];
const MAX_EVIDENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function command(program, args, cwd, options = {}) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, V4_LAYER_GATE_CHILD: '1', ...(options.env ?? {}) },
    timeout: options.timeout ?? 1_800_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.error || result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')} exited ${result.status ?? 'spawn'}\n${stderr}${stdout}`);
  }
  return {
    argv: [program, ...args],
    output: `${stdout}${stderr}`,
  };
}

function branchName(repo) {
  return command('git', ['branch', '--show-current'], repo).output.trim();
}

function currentHead(repo) {
  return command('git', ['rev-parse', '--verify', 'HEAD^{commit}'], repo).output.trim();
}

function resolveCommit(repo, ref) {
  return command('git', ['rev-parse', '--verify', `${ref}^{commit}`], repo).output.trim();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readOptionalJson(file) {
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

function writeExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function sourceScope(truth, sourceCommit, featureId, moduleId, sourcePaths) {
  const inputs = sourcePaths.map((sourcePath) => {
    const identity = truth.blobIdentity(sourceCommit, sourcePath);
    if (!identity) throw new Error(`${sourcePath}: source identity is unavailable at ${sourceCommit}`);
    return identity;
  }).sort((left, right) => left.path.localeCompare(right.path));
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

export function sourceInputsEqual(truth, leftCommit, rightCommit, sourcePaths) {
  return sourcePaths.every((sourcePath) => {
    const left = truth.blobIdentity(leftCommit, sourcePath);
    const right = truth.blobIdentity(rightCommit, sourcePath);
    return left !== null && right !== null && canonicalJson(left) === canonicalJson(right);
  });
}

function evidenceRecord({
  evidenceId,
  issueId,
  experimentId,
  sourceCommit,
  featureId,
  moduleId,
  producer,
  commandArgv,
  sourcePaths,
  truth,
  createdAt,
}) {
  const scope = sourceScope(truth, sourceCommit, featureId, moduleId, sourcePaths);
  const created = new Date(createdAt);
  const expiresAt = new Date(created.getTime() + MAX_EVIDENCE_TTL_MS).toISOString();
  return {
    evidence_id: evidenceId,
    issue_id: issueId,
    experiment_id: experimentId,
    phase: 'development_whitebox',
    kind: 'gate',
    source_commit: sourceCommit,
    execution_surface: 'development_whitebox',
    scope: { feature_id: featureId, module_id: moduleId },
    producer,
    command_argv: commandArgv,
    exit_status: 0,
    result: 'pass',
    created_at: created.toISOString(),
    expires_at: expiresAt,
    input_hashes: scope.input_hashes,
    scope_hash: scope.scope_hash,
  };
}

const REUSABLE_EVIDENCE_FIELDS = [
  'evidence_id',
  'issue_id',
  'experiment_id',
  'phase',
  'kind',
  'source_commit',
  'execution_surface',
  'scope',
  'producer',
  'command_argv',
  'exit_status',
  'result',
  'input_hashes',
  'scope_hash',
];

function reusableEvidenceRecord(existing, expected, now) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return false;
  const identityMatches = REUSABLE_EVIDENCE_FIELDS.every((field) =>
    canonicalJson(existing[field]) === canonicalJson(expected[field]));
  if (!identityMatches) return false;
  const createdAt = Date.parse(existing.created_at ?? '');
  const expiresAt = Date.parse(existing.expires_at ?? '');
  return Number.isFinite(createdAt)
    && Number.isFinite(expiresAt)
    && createdAt <= now
    && createdAt <= expiresAt
    && expiresAt - createdAt <= MAX_EVIDENCE_TTL_MS
    && now <= expiresAt;
}

function extractCommit(repo, commit) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-baseline-replay-'));
  const archive = spawnSync('git', ['archive', commit, '--', 'v4'], {
    cwd: repo,
    encoding: null,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (archive.error || archive.status !== 0) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw new Error(`git archive ${commit} failed (${archive.status ?? 'spawn'})`);
  }
  const extract = spawnSync('tar', ['-xf', '-', '-C', directory], {
    cwd: repo,
    input: archive.stdout,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (extract.error || extract.status !== 0) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw new Error(`tar baseline archive failed (${extract.status ?? 'spawn'}): ${extract.stderr ?? ''}`);
  }
  return { directory, root: path.join(directory, 'v4') };
}

function gateById(verificationMap, gateId) {
  const gate = verificationMap.gates.find((entry) => entry.gate_id === gateId);
  if (!gate || gate.status !== 'active' || !Array.isArray(gate.argv) || gate.argv.length === 0) {
    throw new Error(`GATE_NOT_EXECUTABLE:${gateId}`);
  }
  return gate;
}

function assertOwnerWorktree(repo) {
  const branch = branchName(repo);
  if (!branch.startsWith('codex/') || ['main', 'master', 'v4-cordis'].includes(branch)) {
    throw new Error('OWNER_WORKTREE_REQUIRED');
  }
  const status = command('git', ['status', '--porcelain=v1', '--', 'v4'], repo).output;
  if (status.length > 0) throw new Error('CANDIDATE_WORKTREE_DIRTY');
  return branch;
}

export function manifestProjection(manifest, baselineEvidencePath, closureEvidencePath, decisionEvidencePath, auditCommit) {
  const next = JSON.parse(JSON.stringify(manifest));
  next.baseline.evidence_refs = [{
    role: 'baseline_replay',
    gate_id: BASELINE_GATE_ID,
    path: baselineEvidencePath,
  }];
  next.prerequisites = [{
    feature_id: RUNTIME_FEATURE_ID,
    status: 'pass',
    gap_detected: false,
    epoch_closure_lane_status: 'not_needed_by_evidence',
    audit_commit: auditCommit,
    source_paths: [...RUNTIME_SOURCE_PATHS],
    evidence_refs: [{
      role: 'closure_audit',
      gate_id: CLOSURE_GATE_ID,
      path: closureEvidencePath,
    }],
  }];
  const hBatch = next.batches.find((batch) => batch.batch_id === 'H');
  if (!hBatch) throw new Error('BATCH_H_MISSING');
  hBatch.owner_binding_status = 'bound';
  hBatch.owner_function_id = 'v4.node_container.execution_epoch';
  hBatch.module_ids = ['routecodex-v4-node-container'];
  hBatch.owned_paths = ['crates/routecodex-v4-node-container/**'];
  hBatch.status = 'not_needed_by_evidence';
  hBatch.tasks = [{
    task_id: RUNTIME_FEATURE_ID,
    status: 'not_needed_by_evidence',
    candidate_record: null,
    function_ids: [],
    resource_ids: [],
    source_paths: [],
    support_paths: [],
    required_gate_ids: [],
    mainline_binding: 'forbidden_before_integration',
    evidence_refs: [{
      role: 'not_needed_decision',
      gate_id: CLOSURE_GATE_ID,
      path: decisionEvidencePath,
    }],
  }];
  return next;
}

export function produceFeatureLayerEvidence({
  repositoryRoot = repoRoot,
  projectRoot = v4Root,
  now = Date.now(),
} = {}) {
  const branch = assertOwnerWorktree(repositoryRoot);
  const truth = createGitTruth({ repoRoot: repositoryRoot, v4Root: projectRoot });
  const head = currentHead(repositoryRoot);
  const manifestPath = path.join(projectRoot, 'contracts/feature-completion-layer-batches.manifest.json');
  const verificationMapPath = path.join(projectRoot, 'docs/architecture/maps/verification-map.json');
  const manifest = readJson(manifestPath);
  const verificationMap = readJson(verificationMapPath);
  const baseline = manifest.baseline;
  if (!baseline || baseline.feature_id !== BASELINE_FEATURE_ID) throw new Error('BASELINE_CONTRACT_INVALID');
  const baselineCommit = resolveCommit(repositoryRoot, baseline.required_commit);
  if (baselineCommit !== baseline.resolved_commit) throw new Error('BASELINE_COMMIT_UNRESOLVED');
  const baselineGate = gateById(verificationMap, BASELINE_GATE_ID);
  const closureGate = gateById(verificationMap, CLOSURE_GATE_ID);
  const baselineScope = sourceScope(truth, baselineCommit, BASELINE_FEATURE_ID, RUNTIME_MODULE_ID, BASELINE_SOURCE_PATHS);
  const createdAt = new Date(now).toISOString();
  const producer = { adapter: 'cargo', identity: closureGate.producer.identity };
  const prerequisite = manifest.prerequisites?.find((entry) => entry.feature_id === RUNTIME_FEATURE_ID);
  const priorAuditCommit = prerequisite?.audit_commit
    ? resolveCommit(repositoryRoot, prerequisite.audit_commit)
    : null;
  let runtimeEvidenceCommit = head;
  if (priorAuditCommit
      && priorAuditCommit !== head
      && truth.isAncestor(priorAuditCommit, head)
      && sourceInputsEqual(truth, priorAuditCommit, head, RUNTIME_SOURCE_PATHS)) {
    const priorClosureEvidenceId = `closure-audit-${priorAuditCommit.slice(0, 12)}`;
    const priorDecisionEvidenceId = `not-needed-decision-${priorAuditCommit.slice(0, 12)}`;
    const priorClosureEvidencePath = `docs/evidence/feature-completion/M1/${RUNTIME_FEATURE_ID}/${priorClosureEvidenceId}.json`;
    const priorDecisionEvidencePath = `docs/evidence/feature-completion/M1/${RUNTIME_FEATURE_ID}/${priorDecisionEvidenceId}.json`;
    const priorTask = manifest.batches
      ?.find((batch) => batch.batch_id === 'H')
      ?.tasks?.find((task) => task.task_id === RUNTIME_FEATURE_ID);
    const refsMatch = prerequisite.evidence_refs?.length === 1
      && prerequisite.evidence_refs[0].path === priorClosureEvidencePath
      && priorTask?.evidence_refs?.length === 1
      && priorTask.evidence_refs[0].path === priorDecisionEvidencePath;
    const priorClosureExpected = evidenceRecord({
      evidenceId: priorClosureEvidenceId,
      issueId: RUNTIME_FEATURE_ID,
      experimentId: `v4-runtime-002-epoch-lifecycle-${priorAuditCommit.slice(0, 12)}`,
      sourceCommit: priorAuditCommit,
      featureId: RUNTIME_FEATURE_ID,
      moduleId: RUNTIME_MODULE_ID,
      producer,
      commandArgv: closureGate.argv,
      sourcePaths: RUNTIME_SOURCE_PATHS,
      truth,
      createdAt,
    });
    const priorDecisionExpected = evidenceRecord({
      evidenceId: priorDecisionEvidenceId,
      issueId: RUNTIME_FEATURE_ID,
      experimentId: `v4-runtime-002-epoch-lifecycle-${priorAuditCommit.slice(0, 12)}`,
      sourceCommit: priorAuditCommit,
      featureId: RUNTIME_FEATURE_ID,
      moduleId: RUNTIME_MODULE_ID,
      producer,
      commandArgv: closureGate.argv,
      sourcePaths: RUNTIME_SOURCE_PATHS,
      truth,
      createdAt,
    });
    if (refsMatch
        && reusableEvidenceRecord(readOptionalJson(path.join(projectRoot, priorClosureEvidencePath)), priorClosureExpected, now)
        && reusableEvidenceRecord(readOptionalJson(path.join(projectRoot, priorDecisionEvidencePath)), priorDecisionExpected, now)) {
      runtimeEvidenceCommit = priorAuditCommit;
    }
  }
  const baselineEvidenceId = `baseline-replay-${baselineCommit.slice(0, 12)}`;
  const closureEvidenceId = `closure-audit-${runtimeEvidenceCommit.slice(0, 12)}`;
  const decisionEvidenceId = `not-needed-decision-${runtimeEvidenceCommit.slice(0, 12)}`;
  const baselineEvidencePath = `docs/evidence/feature-completion/M1/${BASELINE_FEATURE_ID}/${baselineEvidenceId}.json`;
  const closureEvidencePath = `docs/evidence/feature-completion/M1/${RUNTIME_FEATURE_ID}/${closureEvidenceId}.json`;
  const decisionEvidencePath = `docs/evidence/feature-completion/M1/${RUNTIME_FEATURE_ID}/${decisionEvidenceId}.json`;
  const allPaths = [baselineEvidencePath, closureEvidencePath, decisionEvidencePath];
  const baselineEvidence = {
    evidence_id: baselineEvidenceId,
    issue_id: BASELINE_FEATURE_ID,
    experiment_id: `v4-current-tree-runtime-007-replay-${baselineCommit.slice(0, 12)}`,
    phase: 'baseline_reproduction',
    kind: 'sample_replay',
    source_commit: baselineCommit,
    execution_surface: 'development_whitebox',
    scope: { feature_id: BASELINE_FEATURE_ID, module_id: RUNTIME_MODULE_ID },
    producer: baselineGate.producer,
    command_argv: baselineGate.argv,
    exit_status: 0,
    result: 'pass',
    created_at: createdAt,
    expires_at: new Date(now + MAX_EVIDENCE_TTL_MS).toISOString(),
    input_hashes: baselineScope.input_hashes,
    scope_hash: baselineScope.scope_hash,
  };
  const closureEvidence = evidenceRecord({
    evidenceId: closureEvidenceId,
    issueId: RUNTIME_FEATURE_ID,
    experimentId: `v4-runtime-002-epoch-lifecycle-${runtimeEvidenceCommit.slice(0, 12)}`,
    sourceCommit: runtimeEvidenceCommit,
    featureId: RUNTIME_FEATURE_ID,
    moduleId: RUNTIME_MODULE_ID,
    producer,
    commandArgv: closureGate.argv,
    sourcePaths: RUNTIME_SOURCE_PATHS,
    truth,
    createdAt,
  });
  const decisionEvidence = evidenceRecord({
    evidenceId: decisionEvidenceId,
    issueId: RUNTIME_FEATURE_ID,
    experimentId: `v4-runtime-002-epoch-lifecycle-${runtimeEvidenceCommit.slice(0, 12)}`,
    sourceCommit: runtimeEvidenceCommit,
    featureId: RUNTIME_FEATURE_ID,
    moduleId: RUNTIME_MODULE_ID,
    producer,
    commandArgv: closureGate.argv,
    sourcePaths: RUNTIME_SOURCE_PATHS,
    truth,
    createdAt,
  });
  const expectedEvidence = [baselineEvidence, closureEvidence, decisionEvidence];
  const reusable = expectedEvidence.map((expected, index) => {
    const relativePath = allPaths[index];
    const file = path.join(projectRoot, relativePath);
    if (!fs.existsSync(file)) return false;
    const existing = readJson(file);
    if (!reusableEvidenceRecord(existing, expected, now)) {
      throw new Error(`EVIDENCE_RECORD_EXISTS:${relativePath}`);
    }
    return true;
  });

  if (!reusable[0]) {
    const baselineWorkspace = extractCommit(repositoryRoot, baselineCommit);
    try {
      command(baselineGate.argv[0], baselineGate.argv.slice(1), baselineWorkspace.root, {
        env: { CARGO_TARGET_DIR: path.join(baselineWorkspace.directory, 'target') },
      });
    } finally {
      fs.rmSync(baselineWorkspace.directory, { recursive: true, force: true });
    }
  }
  let closureReceipt = null;
  if (!reusable[1] || !reusable[2]) {
    closureReceipt = truth.runGate(closureGate.argv);
    if (closureReceipt.status !== 0) {
      throw new Error(`CLOSURE_GATE_FAILED:${closureReceipt.status}\n${closureReceipt.stderr}${closureReceipt.stdout}`);
    }
  }
  const nextManifest = manifestProjection(
    manifest,
    baselineEvidencePath,
    closureEvidencePath,
    decisionEvidencePath,
    runtimeEvidenceCommit,
  );
  if (!reusable[0]) writeExclusive(path.join(projectRoot, baselineEvidencePath), baselineEvidence);
  if (!reusable[1]) writeExclusive(path.join(projectRoot, closureEvidencePath), closureEvidence);
  if (!reusable[2]) writeExclusive(path.join(projectRoot, decisionEvidencePath), decisionEvidence);
  writeExclusive(`${manifestPath}.next`, nextManifest);
  fs.renameSync(`${manifestPath}.next`, manifestPath);
  return {
    branch,
    source_commit: head,
    baseline_commit: baselineCommit,
    evidence_paths: allPaths,
    closure_receipt: closureReceipt
      ? sha256(canonicalJson({
        argv: closureGate.argv,
        status: closureReceipt.status,
        stdout: closureReceipt.stdout,
        stderr: closureReceipt.stderr,
      }))
      : null,
    reused_evidence_paths: allPaths.filter((_, index) => reusable[index]),
  };
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === scriptPath;
if (direct) {
  if (process.argv.length !== 2) {
    console.error('usage: node scripts/architecture/produce-v4-feature-layer-evidence.mjs');
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(produceFeatureLayerEvidence(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
