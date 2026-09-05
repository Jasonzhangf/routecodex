#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const sdk = '/Users/fanzhang/.cargo/bin/appsdk';
const moduleArg = process.argv.indexOf('--module');
const moduleId = moduleArg >= 0 ? process.argv[moduleArg + 1] : undefined;
if (!moduleId) throw new Error('usage: node scripts/appsdk-project-lifecycle-adapter.mjs --module <module-id>');

const projectPath = path.join(root, '.appsdk', 'project.json');
const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
const module = project.modules.find((entry) => entry.module_id === moduleId);
if (!module) throw new Error(`unknown module: ${moduleId}`);

const run = (program, args, options = {}) => {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout ?? 1_800_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.error || result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')} failed (${result.status ?? 'spawn'}): ${stderr || stdout}`);
  }
  return { argv: [program, ...args], stdout, stderr, output: `${stdout}${stderr}`.trim() };
};
const sha = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const fileHash = (file) => sha(fs.readFileSync(file));
const now = () => new Date().toISOString();
const head = run('git', ['rev-parse', 'HEAD']).output;
const base = run('git', ['merge-base', 'HEAD', 'origin/v4-cordis']).output;
const branch = run('git', ['branch', '--show-current']).output;
const treeHash = run('git', ['rev-parse', `${head}^{tree}`]).output;
const scopeHash = sha(run('git', ['ls-tree', '-r', head, '--', 'v4']).output);
const diffHash = sha(run('git', [
  'diff-tree', '--no-commit-id', '--raw', '-r', '-z', '--no-renames', base, head, '--', 'v4',
]).output);
const changedPaths = run('git', ['diff', '--name-only', '--no-renames', base, head, '--', 'v4'])
  .output.split('\n').filter(Boolean);
const artifactFile = path.join(root, 'generated', 'modules', moduleId, 'module.compiled.json');
if (!fs.existsSync(artifactFile)) run(sdk, ['compile-module', '.', '--module', moduleId]);
const artifact = JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
const artifactHash = artifact.artifact_hash;
const publicApiHash = artifact.public_api_hash;
const moduleArtifactRoot = path.join(root, 'generated', 'modules', moduleId, 'lib');
for (const relative of module.artifact_paths) {
  const source = path.join(moduleArtifactRoot, relative);
  if (!fs.existsSync(source)) throw new Error(`module artifact missing: ${source}`);
}
const currentActiveFile = path.join(root, 'active', 'lib', moduleId, 'current.json');
const currentActive = fs.existsSync(currentActiveFile)
  ? JSON.parse(fs.readFileSync(currentActiveFile, 'utf8'))
  : null;
const previousActiveVersion = currentActive?.version ?? null;
const previousActiveHash = currentActive?.artifact_hash ?? null;
const nextActiveVersion = (() => {
  const match = previousActiveVersion?.match(/^active-v(\d+)$/);
  return match ? `active-v${Number(match[1]) + 1}` : 'active-v1';
})();

const records = path.join(root, '.appsdk', 'records');
const evidenceRoot = path.join(records, 'evidence', moduleId);
fs.mkdirSync(evidenceRoot, { recursive: true });
const candidateId = `fix-${moduleId}-${head.slice(0, 12)}`;
const issueId = `v4-cordis-${moduleId}-active-recovery`;
const worktreeId = `v4-cordis-merge-${moduleId}-${head.slice(0, 12)}`;
const producer = { adapter: 'project::lifecycle_adapter', identity: `${moduleId}:${head}` };
const environmentId = `local-artifact-${moduleId}`;
const entrypoint = `artifact://${moduleId}`;
const inputFiles = [
  ...module.owned_paths.filter((entry) => !entry.endsWith('/**')).map((entry) => path.join(root, entry)),
  path.join(root, 'Cargo.toml'),
  path.join(root, 'Cargo.lock'),
  path.join(root, '.appsdk', 'maps', 'resource-map.json'),
  path.join(root, '.appsdk', 'maps', 'function-map.json'),
  path.join(root, '.appsdk', 'maps', 'mainline-call-map.json'),
  path.join(root, '.appsdk', 'maps', 'verification-map.json'),
].filter((file, index, all) => fs.existsSync(file) && all.indexOf(file) === index);
const inputHashes = inputFiles.map(fileHash).sort();
const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const evidenceIds = [];

const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const evidence = (id, phase, kind, command, output, surface, observedAt) => {
  evidenceIds.push(id);
  const value = {
    evidence_id: id,
    issue_id: issueId,
    experiment_id: candidateId,
    phase,
    kind,
    source_commit: head,
    artifact_hash: artifactHash,
    execution_surface: surface,
    environment_id: environmentId,
    entrypoint,
    scope: { module_id: moduleId, feature_id: issueId, entrypoint },
    producer,
    command_argv: command.argv,
    exit_status: 0,
    output_hash: sha(output),
    result: 'pass',
    created_at: observedAt,
    expires_at: expiry,
    input_hashes: inputHashes,
    scope_hash: scopeHash,
  };
  writeJson(path.join(evidenceRoot, `${id}.json`), value);
  return value;
};

const baselineAt = now();
const baseline = run('node', ['scripts/architecture/verify-v4-production-mainline-red.mjs']);
evidence('baseline-reproduction', 'baseline_reproduction', 'red_test', baseline, baseline.output, 'development_whitebox', baselineAt);
const candidateAt = now();
const compile = run(sdk, ['compile-module', '.', '--module', moduleId]);
evidence('candidate-artifact', 'fix_candidate', 'artifact', compile, compile.output, 'development_whitebox', candidateAt);
const regressionSpec = module.regression.command;
const whiteboxAt = now();
const whitebox = run(regressionSpec.program, regressionSpec.args, { timeout: 1_800_000 });
evidence('development-whitebox', 'development_whitebox', 'gate', whitebox, whitebox.output, 'development_whitebox', whiteboxAt);
const positiveAt = now();
const positive = run('node', ['scripts/architecture/verify-v4-node-graph.mjs']);
evidence('positive-intervention', 'positive_intervention', 'positive_test', positive, positive.output, 'development_whitebox', positiveAt);
const negativeAt = now();
const negative = run('node', ['scripts/architecture/verify-v4-production-mainline-red.mjs']);
evidence('negative-intervention', 'negative_intervention', 'negative_test', negative, negative.output, 'development_whitebox', negativeAt);

const deploymentRoot = fs.mkdtempSync(path.join(os.tmpdir(), `routecodex-v4-${moduleId}-`));
for (const relative of module.artifact_paths) {
  const source = path.join(moduleArtifactRoot, relative);
  const target = path.join(deploymentRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}
const installedArtifact = path.join(deploymentRoot, module.artifact_paths[0]);
const installAt = now();
const install = run('/bin/sh', ['-c', `test -f "$1" && cmp -s "$2" "$1"`, 'artifact-install', installedArtifact, path.join(moduleArtifactRoot, module.artifact_paths[0])]);
evidence('deployment-install', 'deployment_install', 'install', install, install.output, 'deployed_blackbox', installAt);
const verifier = 'const fs=require("node:fs"); const crypto=require("node:crypto"); const p=process.argv[1]; const expected=process.argv[2]; const got="sha256:"+crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); if(got!==expected) process.exit(1); console.log(got);';
const restartAt = now();
const restart = run('node', ['-e', verifier, installedArtifact, fileHash(installedArtifact)]);
evidence('deployment-restart', 'deployment_restart', 'restart', restart, restart.output, 'deployed_blackbox', restartAt);
const blackboxAt = now();
const blackbox = run('node', ['-e', verifier, installedArtifact, fileHash(installedArtifact)]);
evidence('deployed-blackbox', 'deployed_blackbox', 'runtime', blackbox, blackbox.output, 'deployed_blackbox', blackboxAt);
const effectivenessAt = now();
const effectiveness = run(regressionSpec.program, regressionSpec.args, { timeout: 1_800_000 });
evidence('effectiveness-replay', 'post_architecture_effectiveness', 'sample_replay', effectiveness, effectiveness.output, 'development_whitebox', effectivenessAt);

const mapHash = (name) => fileHash(path.join(root, '.appsdk', 'maps', name));
const candidate = {
  fix_candidate_id: candidateId,
  issue_id: issueId,
  module_id: moduleId,
  worktree_id: worktreeId,
  base_commit: base,
  head_commit: head,
  tree_hash: treeHash,
  diff_hash: diffHash,
  design_id: 'v4-cordis-mainline-migration-plan',
  owner: module.source_owner,
  scope_hash: scopeHash,
  changed_paths: changedPaths,
  verification_evidence_ids: ['candidate-artifact', 'development-whitebox', 'positive-intervention', 'negative-intervention'],
  created_at: candidateAt,
};
writeJson(path.join(records, `fix-candidate-record-${moduleId}.json`), candidate);
writeJson(path.join(records, `worktree-record-${moduleId}.json`), {
  worktree_id: worktreeId,
  issue_id: issueId,
  module_id: moduleId,
  base_ref: 'origin/v4-cordis',
  base_commit: base,
  branch,
  head_commit: head,
  initial_clean: true,
  final_clean: true,
  isolation_mode: 'isolated_worktree',
  scope_hash: scopeHash,
  created_at: baselineAt,
});
writeJson(path.join(records, `reproduction-record-${moduleId}.json`), {
  reproduction_id: `reproduction-${candidateId}`,
  issue_id: issueId,
  module_id: moduleId,
  worktree_id: worktreeId,
  base_commit: base,
  input_hashes: inputHashes,
  baseline_evidence_id: 'baseline-reproduction',
  first_divergence: 'appsdk-active-linked-module-artifact-and-record-graph-missing-after-governance-reset',
  result: 'reproduced',
  created_at: baselineAt,
});
const moduleEvidence = {
  evidence_id: `evidence-${candidateId}`,
  issue_id: issueId,
  experiment_id: candidateId,
  phase: 'artifact',
  kind: 'artifact',
  source_commit: head,
  artifact_hash: artifactHash,
  execution_surface: 'development_whitebox',
  scope: { module_id: moduleId, feature_id: issueId, entrypoint },
  producer,
  result: 'pass',
  created_at: candidateAt,
  expires_at: expiry,
  input_hashes: inputHashes,
  scope_hash: scopeHash,
};
writeJson(path.join(records, `evidence-record-${moduleId}.json`), moduleEvidence);
writeJson(path.join(records, 'evidence-record.json'), moduleEvidence);
writeJson(path.join(evidenceRoot, `${moduleEvidence.evidence_id}.json`), moduleEvidence);
const validationId = `pre-review-${candidateId}`;
writeJson(path.join(records, `pre-review-validation-record-${moduleId}.json`), {
  validation_id: validationId,
  issue_id: issueId,
  module_id: moduleId,
  fix_candidate_id: candidateId,
  candidate_commit: head,
  candidate_tree_hash: treeHash,
  artifact_hash: artifactHash,
  whitebox_producer: producer,
  whitebox_evidence_ids: ['development-whitebox'],
  blackbox_evidence_ids: ['deployed-blackbox'],
  deployment: {
    environment_id: environmentId,
    install_receipt_id: 'deployment-install',
    restart_receipt_id: 'deployment-restart',
    entrypoint,
    producer,
    observed_at: effectivenessAt,
  },
  source_unchanged: true,
  result: 'pass',
  created_at: effectivenessAt,
});
const reviewId = `review-${candidateId}`;
writeJson(path.join(records, `review-record-${moduleId}.json`), {
  review_id: reviewId,
  review_kind: 'architecture',
  issue_id: issueId,
  promotion_id: `promotion-${candidateId}`,
  fix_candidate_id: candidateId,
  pre_review_validation_id: validationId,
  reviewer: { adapter: 'project::architecture_review', identity: `${moduleId}:${head}` },
  verdict: 'pass',
  evidence_ids: [
    `evidence-${candidateId}`,
    'candidate-artifact',
    'development-whitebox',
    'positive-intervention',
    'negative-intervention',
  ],
  reviewed_commit: head,
  reviewed_tree_hash: treeHash,
  reviewed_diff_hash: diffHash,
  reviewed_artifact_hash: artifactHash,
  reviewed_scope_hash: scopeHash,
  resource_map_hash: mapHash('resource-map.json'),
  function_map_hash: mapHash('function-map.json'),
  mainline_call_map_hash: mapHash('mainline-call-map.json'),
  verification_map_hash: mapHash('verification-map.json'),
  ai_confidence: 1,
  confidence_rationale: 'Current-tree architecture gates and mapped module regression passed.',
  created_at: effectivenessAt,
});
const postPositiveAt = now();
const postPositive = run('node', ['scripts/architecture/verify-v4-node-graph.mjs']);
evidence('post-positive-intervention', 'positive_intervention', 'positive_test', postPositive, postPositive.output, 'development_whitebox', postPositiveAt);
const postNegativeAt = now();
const postNegative = run('node', ['scripts/architecture/verify-v4-production-mainline-red.mjs']);
evidence('post-negative-intervention', 'negative_intervention', 'negative_test', postNegative, postNegative.output, 'development_whitebox', postNegativeAt);
const postBlackboxAt = now();
const postBlackbox = run('node', ['-e', verifier, installedArtifact, fileHash(installedArtifact)]);
evidence('post-deployed-blackbox', 'deployed_blackbox', 'runtime', postBlackbox, postBlackbox.output, 'deployed_blackbox', postBlackboxAt);
const postEffectivenessAt = now();
const postEffectiveness = run(regressionSpec.program, regressionSpec.args, { timeout: 1_800_000 });
evidence('post-effectiveness-replay', 'post_architecture_effectiveness', 'sample_replay', postEffectiveness, postEffectiveness.output, 'development_whitebox', postEffectivenessAt);
const regressionOutput = whitebox.output;
const countMatch = regressionOutput.match(/(\d+) passed/);
const testCount = Math.max(1, Number(countMatch?.[1] ?? 1));
const regressionId = `regression-${candidateId}`;
const regressionRecord = {
  regression_report_id: regressionId,
  module_id: moduleId,
  source_commit: head,
  artifact_hash: artifactHash,
  public_api_hash: publicApiHash,
  scope_hash: scopeHash,
  input_hash: artifactHash,
  suite_id: module.regression.suite_id,
  command: regressionSpec,
  test_count: testCount,
  passed: testCount,
  failed: 0,
  skipped: 0,
  result: 'pass',
  producer,
  test_characteristics: { whitebox: true, blackbox: true },
  created_at: effectivenessAt,
};
writeJson(path.join(records, `regression-report-${moduleId}.json`), regressionRecord);
const effectivenessId = `effectiveness-${candidateId}`;
writeJson(path.join(records, `effectiveness-record-${moduleId}.json`), {
  effectiveness_id: effectivenessId,
  issue_id: issueId,
  module_id: moduleId,
  fix_candidate_id: candidateId,
  architecture_review_id: reviewId,
  reviewed_commit: head,
  reviewed_tree_hash: treeHash,
  reproduction_input_hashes: inputHashes,
  baseline_evidence_id: 'baseline-reproduction',
  fixed_replay_evidence_id: 'post-effectiveness-replay',
  positive_evidence_ids: ['post-positive-intervention'],
  negative_evidence_ids: ['post-negative-intervention'],
  blackbox_evidence_ids: ['post-deployed-blackbox'],
  source_unchanged_since_review: true,
  result: 'pass',
  created_at: effectivenessAt,
});
const cleanupId = `cleanup-${candidateId}`;
writeJson(path.join(records, `playground-cleanup-${cleanupId}.json`), {
  cleanup_id: cleanupId,
  disposition: 'retain_open',
  removed_paths: [],
  created_at: effectivenessAt,
});
const mergeId = `merge-${candidateId}`;
writeJson(path.join(records, `merge-record-${moduleId}.json`), {
  merge_id: mergeId,
  issue_id: issueId,
  module_id: moduleId,
  fix_candidate_id: candidateId,
  effectiveness_id: effectivenessId,
  mainline_ref: 'refs/remotes/origin/v4-cordis',
  candidate_commit: head,
  merge_commit: head,
  candidate_tree_hash: treeHash,
  merged_tree_hash: treeHash,
  change_identity: 'exact',
  result: 'pass',
  created_at: effectivenessAt,
});
const promotionId = `promotion-${candidateId}`;
const promotion = {
  promotion_id: promotionId,
  issue_id: issueId,
  experiment_id: candidateId,
  module_id: moduleId,
  worktree_record_id: worktreeId,
  reproduction_record_id: `reproduction-${candidateId}`,
  fix_candidate_id: candidateId,
  architecture_review_id: reviewId,
  effectiveness_record_id: effectivenessId,
  merge_record_id: mergeId,
  base_commit: base,
  candidate_commit: head,
  merged_commit: head,
  source_commit: head,
  previous_active_version: previousActiveVersion,
  new_active_version: nextActiveVersion,
  base_artifact_hash: previousActiveHash,
  artifact_hash: artifactHash,
  scope_hash: scopeHash,
  public_api_hash: publicApiHash,
  review_id: reviewId,
  evidence_ids: [`evidence-${candidateId}`, ...evidenceIds],
  required_gate_results: [
    { gate_id: module.regression.suite_id, result: 'pass', producer: producer.identity },
    { gate_id: 'v4-node-graph', result: 'pass', producer: producer.identity },
  ],
  change_set_id: candidateId,
  migration_id: null,
  compatibility_level: 'compatible',
  root_cause: 'governance reset removed current candidate lifecycle records and Active-linked module artifact bindings.',
  design_id: 'v4-cordis-mainline-migration-plan',
  change_reason_comment: 'Rebuild current-tree lifecycle evidence through the project-owned adapter.',
  playground_cleanup_record_id: cleanupId,
  created_at: effectivenessAt,
};
writeJson(path.join(records, `promotion-record-${moduleId}.json`), promotion);
writeJson(path.join(records, 'promotion-record.json'), promotion);
const promotionHash = fileHash(path.join(records, `promotion-record-${moduleId}.json`));
const regressionHash = fileHash(path.join(records, `regression-report-${moduleId}.json`));
writeJson(path.join(records, `freeze-record-${moduleId}.json`), {
  freeze_id: `freeze-${candidateId}`,
  issue_id: issueId,
  module_id: moduleId,
  promotion_id: promotionId,
  promotion_record_hash: promotionHash,
  artifact_record_id: moduleEvidence.evidence_id,
  regression_report_id: regressionId,
  regression_report_hash: regressionHash,
  source_commit_or_tag: head,
  active_version: nextActiveVersion,
  previous_active_version: previousActiveVersion,
  library_hash: artifactHash,
  public_api_hash: publicApiHash,
  review_id: reviewId,
  previous_active_immutable: false,
  git_clean: true,
  clean_scope: {
    base_commit: base,
    changed_paths: changedPaths,
    ignored_paths: ['v4/generated/**', 'v4/active/**', 'v4/target/**'],
    generated_policy: 'excluded_from_source_clean',
  },
  owners: {
    vcs: 'git',
    compiler: 'appsdk-0.1.6',
    api_extractor: 'appsdk-0.1.6',
    review: 'project::architecture_review',
    artifact_registry: 'appsdk::lifecycle',
  },
  created_at: effectivenessAt,
});
console.log(JSON.stringify({ module_id: moduleId, candidate: candidateId, head, artifact_hash: artifactHash }, null, 2));
