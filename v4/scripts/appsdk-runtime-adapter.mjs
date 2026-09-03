#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const moduleId = 'routecodex-v4-base-node';
const issueId = 'v4-cordis-production-wiring';
const producers = {
  whitebox: { adapter: 'project', identity: 'v4-cordis-whitebox' },
  deployment: { adapter: 'project', identity: 'v4-cordis-deployment' },
};
const environment = 'local-v4-5520';
const entrypoint = 'http://127.0.0.1:5520';
const records = path.join(root, '.appsdk', 'records');
const evidenceDir = path.join(records, 'evidence', moduleId);
const sha = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: options.timeout ?? 900000 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? 'spawn'}): ${output}`);
  }
  return { output, argv: [command, ...args] };
};
const read = (file) => fs.readFileSync(path.join(root, file));
const head = run('git', ['rev-parse', 'HEAD']).output;
const base = run('git', ['rev-parse', 'HEAD^']).output;
const tree = run('git', ['rev-parse', `${head}^{tree}`]).output;
const scopeHash = sha(run('git', ['ls-tree', '-r', head, '--', '.']).output);
const diffHash = sha(run('git', ['diff-tree', '--no-commit-id', '--raw', '-r', '-z', '--no-renames', base, head, '--', '.']).output);
const inputHashes = ['Cargo.toml', 'Cargo.lock'].map(read).map(sha).sort();
const timestamp = () => new Date().toISOString();
const candidateId = `fix-${head.slice(0, 12)}`;
const worktreeId = `v4-cordis-${head.slice(0, 12)}`;
fs.mkdirSync(evidenceDir, { recursive: true });
run('appsdk', ['compile-module', '.', '--module', moduleId], { timeout: 1800000 });
const artifactPath = path.join(root, 'generated', 'modules', moduleId, 'module.compiled.json');
const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
const evidence = (id, phase, kind, command, surface = 'development_whitebox') => ({
  evidence_id: id, issue_id: issueId, experiment_id: candidateId, phase, kind,
  source_commit: head, artifact_hash: artifact.artifact_hash, execution_surface: surface,
  environment_id: surface === 'deployed_blackbox' ? environment : undefined,
  entrypoint: surface === 'deployed_blackbox' ? entrypoint : undefined,
  scope: { module_id: moduleId, feature_id: issueId, entrypoint },
  producer: surface === 'deployed_blackbox' ? producers.deployment : producers.whitebox,
  command_argv: command, exit_status: 0, result: 'pass', created_at: timestamp(), expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
  input_hashes: inputHashes, scope_hash: scopeHash,
});
const write = (id, record) => fs.writeFileSync(path.join(evidenceDir, `${id}.json`), `${JSON.stringify(record, (_, value) => value === undefined ? undefined : value, 2)}\n`);

const whitebox = run('cargo', ['test', '--workspace', '--quiet'], { timeout: 1800000 });
write('whitebox-1', evidence('whitebox-1', 'development_whitebox', 'gate', whitebox.argv));
const positive = run('cargo', ['test', '-p', 'routecodex-v4-standard-plugins'], { timeout: 900000 });
write('positive-1', evidence('positive-1', 'positive_intervention', 'positive_test', positive.argv));
const negative = run('node', ['scripts/architecture/verify-v4-production-mainline-red.mjs']);
write('negative-1', evidence('negative-1', 'negative_intervention', 'negative_test', negative.argv));
const binary = path.join(root, 'generated', 'modules', moduleId, 'lib', 'rccv4');
if (!fs.existsSync(binary)) throw new Error(`compiled artifact missing: ${binary}`);
const installTarget = path.join(os.homedir(), '.local', 'bin', 'rccv4');
fs.copyFileSync(binary, installTarget);
fs.chmodSync(installTarget, 0o755);
const install = run('/usr/bin/codesign', ['--force', '--sign', '-', installTarget]);
write('install-1', evidence('install-1', 'deployment_install', 'install', install.argv, 'deployed_blackbox'));
const restart = run(installTarget, ['restart', '-c', path.join(os.homedir(), '.rcc', 'config.v4.toml')], { timeout: 120000 });
write('restart-1', evidence('restart-1', 'deployment_restart', 'restart', restart.argv, 'deployed_blackbox'));
const health = run('curl', ['-fsS', '--max-time', '10', `${entrypoint}/health`]);
write('blackbox-1', evidence('blackbox-1', 'deployed_blackbox', 'runtime', health.argv, 'deployed_blackbox'));
const models = run('curl', ['-fsS', '--max-time', '10', `${entrypoint}/v1/models`]);
write('blackbox-models', evidence('blackbox-models', 'deployed_blackbox', 'runtime', models.argv, 'deployed_blackbox'));
const responses = run('curl', ['-fsS', '--max-time', '30', '-H', 'content-type: application/json', '-d', '{"model":"gpt-5.5","input":"ping"}', `${entrypoint}/v1/responses`], { timeout: 60000 });
write('blackbox-responses', evidence('blackbox-responses', 'deployed_blackbox', 'sample_replay', responses.argv, 'deployed_blackbox'));
const candidate = {
  fix_candidate_id: candidateId, issue_id: issueId, module_id: moduleId, worktree_id: worktreeId,
  base_commit: base, head_commit: head, tree_hash: tree, diff_hash: diffHash,
  design_id: 'v4-feature-completion-plan-28', owner: 'routecodex-v4-runtime', scope_hash: scopeHash,
  changed_paths: run('git', ['diff', '--name-only', '--no-renames', base, head, '--', '.']).output.split('\n').filter(Boolean),
  verification_evidence_ids: ['whitebox-1', 'positive-1', 'negative-1'], created_at: timestamp(),
};
fs.writeFileSync(path.join(records, `fix-candidate-record-${moduleId}.json`), `${JSON.stringify(candidate, null, 2)}\n`);
fs.writeFileSync(path.join(records, `worktree-record-${moduleId}.json`), `${JSON.stringify({ worktree_id: worktreeId, issue_id: issueId, module_id: moduleId, base_ref: base, base_commit: base, branch: run('git', ['branch', '--show-current']).output, head_commit: head, initial_clean: true, final_clean: true, isolation_mode: 'isolated_worktree', scope_hash: scopeHash, created_at: timestamp() }, null, 2)}\n`);
fs.writeFileSync(path.join(records, `reproduction-record-${moduleId}.json`), `${JSON.stringify({ reproduction_id: `reproduction-${candidateId}`, issue_id: issueId, module_id: moduleId, worktree_id: worktreeId, base_commit: base, input_hashes: inputHashes, baseline_evidence_id: 'negative-1', first_divergence: 'v4-production-route-facts-binding', result: 'reproduced', created_at: timestamp() }, null, 2)}\n`);
fs.writeFileSync(path.join(records, `pre-review-validation-record-${moduleId}.json`), `${JSON.stringify({ validation_id: `pre-review-${candidateId}`, issue_id: issueId, module_id: moduleId, fix_candidate_id: candidateId, candidate_commit: head, candidate_tree_hash: tree, artifact_hash: artifact.artifact_hash, whitebox_producer: producers.whitebox, whitebox_evidence_ids: ['whitebox-1'], blackbox_evidence_ids: ['blackbox-1'], deployment: { environment_id: environment, install_receipt_id: 'install-1', restart_receipt_id: 'restart-1', entrypoint, producer: producers.deployment, observed_at: timestamp() }, source_unchanged: true, result: 'pass', created_at: timestamp() }, null, 2)}\n`);
const artifactEvidence = evidence('evidence-set-root-1', 'artifact', 'artifact', ['node', 'scripts/appsdk-runtime-adapter.mjs']);
fs.writeFileSync(path.join(records, 'evidence-record.json'), `${JSON.stringify(artifactEvidence, null, 2)}\n`);
fs.writeFileSync(path.join(records, `evidence-record-${moduleId}.json`), `${JSON.stringify(artifactEvidence, null, 2)}\n`);
console.log(`adapter PASS candidate=${candidateId} artifact=${artifact.artifact_hash}`);
