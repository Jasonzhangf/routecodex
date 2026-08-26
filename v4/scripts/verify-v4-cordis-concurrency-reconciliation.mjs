import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(projectRoot, 'contracts', 'v4-cordis-concurrency-reconciliation.manifest.json');
const expectedClaim = 'gate_id:v4.cordis-concurrency-reconciliation';
const expectedMergeTarget = 'codex/v4-cordis-refactor-main';

function violations(manifest) {
  const errors = [];
  if (manifest?.schema_version !== 1) errors.push('schema_version must be 1');
  if (manifest?.issue_id !== 'M00-T10') errors.push('issue_id must be M00-T10');
  if (manifest?.claim_id !== expectedClaim) errors.push(`claim_id must be ${expectedClaim}`);
  if (manifest?.merge_target !== expectedMergeTarget) errors.push(`merge_target must be ${expectedMergeTarget}`);
  if (!Array.isArray(manifest?.tasks) || manifest.tasks.length === 0) {
    errors.push('tasks must be a non-empty array');
  } else {
    for (const [index, task] of manifest.tasks.entries()) {
      const prefix = `tasks[${index}]`;
      if (!task?.task_id) errors.push(`${prefix}.task_id is required`);
      if (!task?.independent_claim) errors.push(`${prefix}.independent_claim is required`);
      if (!Array.isArray(task?.dependencies) || task.dependencies.length === 0) {
        errors.push(`${prefix}.dependencies must be non-empty`);
      }
      if (task?.merge_target !== expectedMergeTarget) {
        errors.push(`${prefix}.merge_target must be ${expectedMergeTarget}`);
      }
      if (!task?.post_merge_mainline_verification) {
        errors.push(`${prefix}.post_merge_mainline_verification is required`);
      }
    }
  }
  if (!Array.isArray(manifest?.delivery_order) || manifest.delivery_order.join('>') !== 'claim>worktree>red>implement>boundary>focused_gates>evidence>checker_merge>mainline_reverify>claim_release>cleanup') {
    errors.push('delivery_order must encode the canonical handoff sequence');
  }
  if (!manifest?.claim_release_cleanup?.release_after) errors.push('claim_release_cleanup.release_after is required');
  if (!manifest?.claim_release_cleanup?.cleanup_after) errors.push('claim_release_cleanup.cleanup_after is required');
  if (!manifest?.blockers?.M05 || !manifest?.blockers?.D0 || !manifest?.blockers?.M08) {
    errors.push('M05, D0, and M08 blocker records are required');
  }
  return errors;
}

function assertPass(manifest, label) {
  const errors = violations(manifest);
  if (errors.length > 0) throw new Error(`${label} failed:\n- ${errors.join('\n- ')}`);
}

function assertRed(mutator, label) {
  let failed = false;
  try {
    mutator();
  } catch {
    failed = true;
  }
  if (!failed) throw new Error(`${label} unexpectedly passed`);
}

const redSelfTest = process.argv.includes('--red-self-test');
let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (error) {
  throw new Error(`cannot load canonical concurrency manifest at ${manifestPath}: ${error.message}`);
}

if (redSelfTest) {
  assertRed(() => assertPass({ ...manifest, tasks: manifest.tasks.map(({ independent_claim: _claim, ...task }) => task) }, 'missing independent claim'), 'missing independent claim');
  assertRed(() => assertPass({ ...manifest, tasks: manifest.tasks.map((task) => ({ ...task, dependencies: [] })) }, 'missing dependency'), 'missing dependency');
  assertRed(() => assertPass({ ...manifest, merge_target: 'main' }, 'wrong manifest merge target'), 'wrong manifest merge target');
  assertRed(() => assertPass({ ...manifest, tasks: manifest.tasks.map((task) => ({ ...task, merge_target: 'main' })) }, 'wrong task merge target'), 'wrong task merge target');
  assertRed(() => assertPass({ ...manifest, tasks: manifest.tasks.map(({ post_merge_mainline_verification: _verify, ...task }) => task) }, 'missing post-merge verification'), 'missing post-merge verification');
  assertRed(() => assertPass({ ...manifest, delivery_order: manifest.delivery_order.filter((step) => step !== 'cleanup') }, 'missing cleanup order'), 'missing cleanup order');
  console.log('PASS v4 Cordis concurrency reconciliation red self-test');
} else {
  assertPass(manifest, 'canonical concurrency manifest');
  console.log(`PASS v4 Cordis concurrency reconciliation (${manifest.tasks.length} tasks)`);
}
