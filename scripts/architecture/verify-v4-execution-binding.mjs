#!/usr/bin/env node
/**
 * v4_parity_gate_execution_binding
 *
 * Locks execution binding (Phase 3/4/6): a request entering the Skeleton must
 * be bound to skeleton_version, manifest_hash, plan_epoch, plan_hash for the
 * whole execution. The compiled skeleton plan contract must require these
 * fields and declare the canonical plan-hash rule from node-container.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    failures.push(`${file}: cannot read/parse: ${error.message}`);
    return null;
  }
};

const plan = readJson('v4/contracts/skeleton-plan.contract.json');
const nodeContainer = readJson('v4/contracts/node-container.contract.json');
if (!plan || !nodeContainer) {
  console.error('[v4_parity_gate_execution_binding] FAIL');
  console.error(failures.join('\n'));
  process.exit(1);
}

const binding = plan.binding ?? {};
for (const field of ['skeleton_version', 'manifest_hash', 'plan_epoch', 'plan_hash']) {
  if (binding.required !== true || !Array.isArray(binding.fields) || !binding.fields.includes(field)) {
    failures.push(`skeleton binding: ${field} must be required in plan.binding.fields`);
  }
}

const hashRule = String(nodeContainer.hash_rule ?? '');
if (!/sha256/i.test(hashRule) || !/canonical/i.test(hashRule)) {
  failures.push('node-container.contract.json: hash_rule must declare canonical sha256 plan hash');
}

if (failures.length > 0) {
  console.error('[v4_parity_gate_execution_binding] FAIL');
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('[v4_parity_gate_execution_binding] OK skeleton_version/manifest_hash/plan_epoch/plan_hash bound');
