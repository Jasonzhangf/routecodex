#!/usr/bin/env node
// Only actual pre-review observations. Review, merge and freeze have separate
// owners; this producer must never infer their success from test results.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdk = '/Users/fanzhang/.cargo/bin/appsdk';
const moduleId = process.argv[process.argv.indexOf('--module') + 1];
if (!process.argv.includes('--module') || moduleId !== 'routecodex-v4-cli-plugin') {
  throw new Error('LIFECYCLE_CAPABILITY_MISSING: only routecodex-v4-cli-plugin has a deployed CLI producer');
}
const run = (program, args) => {
  const result = spawnSync(program, args, {
    cwd: root, encoding: 'utf8', timeout: 1_800_000, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} failed (${result.status}): ${result.error ?? ''}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`);
  }
  return { argv: [program, ...args], output: `${result.stdout}${result.stderr}`, observed_at: new Date().toISOString() };
};
const git = (...args) => run('git', args).output.trim();
const hash = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const read = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const project = read('.appsdk/project.json');
const module = project.modules.find((entry) => entry.module_id === moduleId);
if (!module || JSON.stringify(module.deployment_operations) !== '["install"]') {
  throw new Error('DEPLOYMENT_CONTRACT_MISMATCH: standalone CLI requires install; no managed service exists to restart');
}
const branch = git('branch', '--show-current');
if (!branch || ['main', 'master', 'v4-cordis'].includes(branch)) throw new Error('OWNER_WORKTREE_REQUIRED');
if (git('status', '--porcelain')) throw new Error('CANDIDATE_WORKTREE_DIRTY');
const head = git('rev-parse', 'HEAD');
const tree = git('rev-parse', 'HEAD^{tree}');
const base = git('merge-base', 'HEAD', 'origin/v4-cordis');
const candidateAt = new Date().toISOString();
const candidateId = `${moduleId}-${head}`;
const recordRoot = path.join(root, '.appsdk/records');
const candidatePath = path.join(recordRoot, `fix-candidate-record-${moduleId}.json`);
const validationPath = path.join(recordRoot, `pre-review-validation-record-${moduleId}.json`);
if (fs.existsSync(candidatePath) || fs.existsSync(validationPath)) {
  throw new Error('LIFECYCLE_RECORD_EXISTS: preserve existing records; use canonical version transition before another candidate');
}
const compile = run(sdk, ['compile-module', '.', '--module', moduleId]);
const artifact = read(`generated/modules/${moduleId}/module.compiled.json`);
const artifactFile = path.join(root, `generated/modules/${moduleId}/lib/rccv4-plugin`);
const artifactBytes = fs.readFileSync(artifactFile);
const inputHashes = [hash(fs.readFileSync(fileURLToPath(import.meta.url))), hash(artifactBytes),
  hash(fs.readFileSync(path.join(root, 'scripts/test-cli-plugin.mjs'))),
  hash(fs.readFileSync(path.join(root, '.appsdk/project.json')))];
const scopeHash = hash(git('ls-tree', '-r', head, '--', '.'));
const whitebox = run(module.regression.command.program, module.regression.command.args);
// Isolated CLI installation; the following consumer executes this installed
// executable, never the source tree's target/ binary.
const deployment = fs.mkdtempSync(path.join(os.tmpdir(), 'rccv4-cli-admission-'));
const installed = path.join(deployment, 'bin/rccv4-plugin');
fs.mkdirSync(path.dirname(installed));
const install = run('/usr/bin/install', ['-m', '755', artifactFile, installed]);
if (!fs.readFileSync(installed).equals(artifactBytes)) throw new Error('INSTALLED_ARTIFACT_DRIFT');
const blackbox = run(process.execPath, ['scripts/test-cli-plugin.mjs', '--binary', installed]);
if (git('rev-parse', 'HEAD') !== head || git('status', '--porcelain')) {
  throw new Error('CANDIDATE_CHANGED_DURING_VALIDATION');
}
if (!fs.readFileSync(artifactFile).equals(artifactBytes) || !fs.readFileSync(installed).equals(artifactBytes)) {
  throw new Error('ARTIFACT_CHANGED_DURING_VALIDATION');
}
const identity = `${moduleId}:${head}`;
const whiteboxProducer = { adapter: 'project::whitebox_adapter', identity };
const deploymentProducer = { adapter: 'project::deployment_adapter', identity };
const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const issueId = 'v4-cli-governance-closeout';
const evidence = (phase, kind, receipt, producer, surface) => ({
  evidence_id: `${candidateId}-${phase}`, issue_id: issueId, experiment_id: candidateId,
  phase, kind, source_commit: head, artifact_hash: artifact.artifact_hash,
  execution_surface: surface, environment_id: deployment, entrypoint: installed,
  scope: { module_id: moduleId, feature_id: issueId, entrypoint: installed },
  producer, command_argv: receipt.argv, exit_status: 0,
  output_hash: hash(receipt.output), result: 'pass', created_at: receipt.observed_at,
  expires_at: expiresAt, input_hashes: inputHashes, scope_hash: scopeHash,
});
const observations = [
  evidence('development_whitebox', 'gate', whitebox, whiteboxProducer, 'development_whitebox'),
  evidence('deployment_install', 'install', install, deploymentProducer, 'deployed_blackbox'),
  evidence('deployed_blackbox', 'runtime', blackbox, deploymentProducer, 'deployed_blackbox'),
];
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
};
for (const [name, receipt] of [['compile', compile], ['whitebox', whitebox], ['install', install], ['blackbox', blackbox]]) {
  write(path.join(deployment, `${name}.json`), receipt);
}
for (const observation of observations) {
  write(path.join(recordRoot, 'evidence', moduleId, `${observation.evidence_id}.json`), observation);
}
write(candidatePath, {
  fix_candidate_id: candidateId, issue_id: issueId, module_id: moduleId,
  worktree_id: branch, base_commit: base, head_commit: head, tree_hash: tree,
  diff_hash: hash(git('diff-tree', '--no-commit-id', '--raw', '-r', base, head)),
  design_id: 'v4-cli-plugin', owner: module.source_owner, scope_hash: scopeHash,
  changed_paths: git('diff', '--name-only', base, head).split('\n').filter(Boolean),
  verification_evidence_ids: observations.map((entry) => entry.evidence_id), created_at: candidateAt,
});
write(validationPath, {
  validation_id: `pre-review-${candidateId}`, issue_id: issueId, module_id: moduleId,
  fix_candidate_id: candidateId, candidate_commit: head, candidate_tree_hash: tree,
  artifact_hash: artifact.artifact_hash, whitebox_producer: whiteboxProducer,
  whitebox_evidence_ids: [observations[0].evidence_id],
  blackbox_evidence_ids: [observations[2].evidence_id],
  deployment: { environment_id: deployment, install_receipt_id: observations[1].evidence_id,
    entrypoint: installed, producer: deploymentProducer, observed_at: blackbox.observed_at },
  source_unchanged: true, result: 'pass', created_at: new Date().toISOString(),
});
console.log(JSON.stringify({ candidate: head, artifact: artifact.artifact_hash, deployment,
  next: 'appsdk verify --review-admission . --module routecodex-v4-cli-plugin' }));
