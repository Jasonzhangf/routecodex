#!/usr/bin/env node
/**
 * v4_parity_gate_execution_binding
 *
 * Locks the compiled execution-binding contract (Phase 3/4/6): a request
 * entering the Skeleton must be bound to skeleton_version, manifest_hash,
 * plan_epoch, plan_hash for the whole execution. The compiled skeleton plan
 * contract must require these fields and declare the canonical plan-hash rule
 * from node-container.
 *
 * The Rust consumers are the code-binding owner: `l2_ports.rs` exercises
 * `ExecutionBinding`/`execution_binding()` and binding-drift rejection, and
 * `l2_runtime.rs` exercises `SkeletonPlan` load/`plan_hash`/`verify`. This
 * gate validates only the contract data those consumers are compiled against.
 *
 * Run with --red-self-test to prove each negative class fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const failures = [];

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    failures.push(`${file}: cannot read/parse: ${error.message}`);
    return null;
  }
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const BINDING_FIELDS = ['skeleton_version', 'manifest_hash', 'plan_epoch', 'plan_hash'];

function validateContract(plan, nodeContainer) {
  const problems = [];
  if (!plan || !nodeContainer) {
    return problems;
  }
  const binding = plan.binding ?? {};
  for (const field of BINDING_FIELDS) {
    if (binding.required !== true || !Array.isArray(binding.fields) || !binding.fields.includes(field)) {
      problems.push(`skeleton binding: ${field} must be required in plan.binding.fields`);
    }
  }
  const hashRule = String(nodeContainer.hash_rule ?? '');
  if (!/sha256/i.test(hashRule) || !/canonical/i.test(hashRule)) {
    problems.push('node-container.contract.json: hash_rule must declare canonical sha256 plan hash');
  }
  return problems;
}

function runSelfTest() {
  const plan = readJson('contracts/skeleton-plan.contract.json');
  const nodeContainer = readJson('contracts/node-container.contract.json');
  const cases = [
    ['binding not required', (s) => { s.plan.binding.required = false; }, 'plan_hash must be required'],
    ['binding field dropped', (s) => { s.plan.binding.fields = s.plan.binding.fields.filter((f) => f !== 'plan_epoch'); }, 'plan_epoch must be required'],
    ['binding fields not an array', (s) => { s.plan.binding.fields = 'plan_hash'; }, 'skeleton_version must be required'],
    ['binding block missing', (s) => { delete s.plan.binding; }, 'manifest_hash must be required'],
    ['hash rule lost sha256', (s) => { s.nodeContainer.hash_rule = 'canonical plan hash only'; }, 'canonical sha256'],
    ['hash rule lost canonical', (s) => { s.nodeContainer.hash_rule = 'sha256 of plan body'; }, 'canonical sha256'],
    ['hash rule missing', (s) => { delete s.nodeContainer.hash_rule; }, 'canonical sha256'],
  ];

  let failed = 0;
  for (const [name, mutate, marker] of cases) {
    const state = {
      plan: clone(plan),
      nodeContainer: clone(nodeContainer),
    };
    mutate(state);
    const problems = validateContract(state.plan, state.nodeContainer);
    const hit = problems.some((problem) => problem.includes(marker));
    if (problems.length === 0 || !hit) {
      console.error(`[v4_parity_gate_execution_binding] red self-test ${name}: expected FAIL, got ${problems.length} (marker ${marker})`);
      failed += 1;
    } else {
      console.log(`[v4_parity_gate_execution_binding] red self-test ${name}: FAIL as expected (${problems.length})`);
    }
  }
  const contractProblems = validateContract(plan, nodeContainer);
  if (contractProblems.length > 0) {
    console.error(`[v4_parity_gate_execution_binding] red self-test base: contract invalid (${contractProblems.join('; ')})`);
    process.exit(1);
  }
  if (failed > 0) {
    process.exit(1);
  }
  console.log(`[v4_parity_gate_execution_binding] OK red self-test ${cases.length}/${cases.length}`);
}

if (process.argv.includes('--red-self-test')) {
  runSelfTest();
  process.exit(0);
}

failures.push(...validateContract(
  readJson('contracts/skeleton-plan.contract.json'),
  readJson('contracts/node-container.contract.json'),
));

if (failures.length > 0) {
  console.error('[v4_parity_gate_execution_binding] FAIL');
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('[v4_parity_gate_execution_binding] OK contract binding + canonical plan hash rule locked');
