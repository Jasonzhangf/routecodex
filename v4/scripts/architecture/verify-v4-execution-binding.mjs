#!/usr/bin/env node
/**
 * v4_parity_gate_execution_binding
 *
 * Locks execution binding (Phase 3/4/6): a request entering the Skeleton must
 * be bound to skeleton_version, manifest_hash, plan_epoch, plan_hash for the
 * whole execution. The compiled skeleton plan contract must require these
 * fields and declare the canonical plan-hash rule from node-container.
 *
 * Code binding (AGENTS §20/§29): registry self-consistency is not enough.
 * The Rust runtime must actually implement `ExecutionBinding` +
 * `execution_binding()` and consume it in the chain runner, and the skeleton
 * crate must implement the contract loader/verifier (`SkeletonPlan`,
 * `plan_hash`, `from_contract_json`, `verify`).
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

const readText = (file) => {
  try {
    return fs.readFileSync(path.join(root, file), 'utf8');
  } catch (error) {
    failures.push(`${file}: cannot read: ${error.message}`);
    return '';
  }
};

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

function validateCodeBinding(runtimeSource, skeletonSource) {
  const problems = [];

  const bindingDecl = runtimeSource.match(/pub struct ExecutionBinding\s*\{([^}]*)\}/);
  if (!bindingDecl) {
    problems.push('runtime: pub struct ExecutionBinding missing (registry is not implemented)');
  } else {
    for (const field of BINDING_FIELDS) {
      if (!bindingDecl[1].includes(`pub ${field}:`)) {
        problems.push(`runtime: ExecutionBinding missing field ${field}`);
      }
    }
  }
  if (!/pub fn execution_binding\(/.test(runtimeSource)) {
    problems.push('runtime: pub fn execution_binding() missing');
  }
  if (!/execution_binding\(&self\.plan\)/.test(runtimeSource)) {
    problems.push('runtime: execution_binding() is not consumed by the chain runner');
  }
  if (!/pub struct SkeletonRuntime\b/.test(runtimeSource)) {
    problems.push('runtime: pub struct SkeletonRuntime missing (mainline executor is not implemented)');
  }
  if (!/pub struct NodePluginPlan\b/.test(runtimeSource)) {
    problems.push('runtime: pub struct NodePluginPlan missing (compiled plan type is not implemented)');
  }
  if (!/pub static PLUGIN_REGISTRY\b/.test(runtimeSource)) {
    problems.push('runtime: pub static PLUGIN_REGISTRY missing (plugin registry is not implemented)');
  }
  if (!/fn run_chain\(/.test(runtimeSource)) {
    problems.push('runtime: run_chain() missing (chain execution path is not implemented)');
  }

  if (!/pub struct SkeletonPlan\b/.test(skeletonSource)) {
    problems.push('skeleton: pub struct SkeletonPlan missing');
  }
  if (!/pub fn plan_hash\(/.test(skeletonSource)) {
    problems.push('skeleton: pub fn plan_hash() missing');
  }
  if (!/pub fn from_contract_json\(/.test(skeletonSource)) {
    problems.push('skeleton: pub fn from_contract_json() missing');
  }
  if (!/pub fn verify\(/.test(skeletonSource)) {
    problems.push('skeleton: pub fn verify() missing');
  }
  return problems;
}

function loadSource() {
  return {
    runtime: readText('crates/routecodex-v4-runtime/src/lib.rs'),
    skeleton: readText('crates/routecodex-v4-skeleton/src/lib.rs'),
  };
}

function runSelfTest() {
  const plan = readJson('contracts/skeleton-plan.contract.json');
  const nodeContainer = readJson('contracts/node-container.contract.json');
  const base = loadSource();
  const cases = [
    ['runtime ExecutionBinding ghost', (s) => {
      s.runtime = s.runtime.replace('pub struct ExecutionBinding', 'pub struct GhostBinding');
    }, 'ExecutionBinding missing'],
    ['binding field removed', (s) => {
      s.runtime = s.runtime.replace('    pub plan_hash: String,', '');
    }, 'missing field plan_hash'],
    ['runtime execution_binding fn ghost', (s) => {
      s.runtime = s.runtime.replace('pub fn execution_binding(', 'pub fn ghost_binding(');
    }, 'execution_binding() missing'],
    ['binding not consumed', (s) => {
      s.runtime = s.runtime.replace('execution_binding(&self.plan)', 'ghost_binding(&self.plan)');
    }, 'not consumed'],
    ['skeleton plan_hash ghost', (s) => {
      s.skeleton = s.skeleton.replace('pub fn plan_hash(', 'pub fn ghost_hash(');
    }, 'plan_hash() missing'],
    ['skeleton contract loader ghost', (s) => {
      s.skeleton = s.skeleton.replace('pub fn from_contract_json(', 'pub fn from_contract(');
    }, 'from_contract_json() missing'],
    ['skeleton verifier ghost', (s) => {
      s.skeleton = s.skeleton.replace('pub fn verify(', 'pub fn ghost_verify(');
    }, 'verify() missing'],
  ];

  let failed = 0;
  for (const [name, mutate, marker] of cases) {
    const state = {
      runtime: base.runtime,
      skeleton: base.skeleton,
    };
    mutate(state);
    const problems = validateCodeBinding(state.runtime, state.skeleton);
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

failures.push(...validateContract(readJson('contracts/skeleton-plan.contract.json'), readJson('contracts/node-container.contract.json')));
const source = loadSource();
failures.push(...validateCodeBinding(source.runtime, source.skeleton));

if (failures.length > 0) {
  console.error('[v4_parity_gate_execution_binding] FAIL');
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('[v4_parity_gate_execution_binding] OK contract + Rust runtime/skeleton code binding locked');
