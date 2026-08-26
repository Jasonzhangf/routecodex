import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const contractPath = path.join(root, 'contracts/m11-protocol-tools-admin.contract.json');

function contractErrors(contract) {
  const errors = [];
  if (contract.status !== 'contract_bound') errors.push('status');
  if (contract.owner_feature_id !== 'v4.cordis_m11_protocol_tools_admin_contract') {
    errors.push('owner_feature_id');
  }
  if (contract.lanes?.map((lane) => lane.lane_id).join(',') !== 'protocol,tools,admin') {
    errors.push('lane_order');
  }
  if (contract.payload_boundary?.normal_payload_access !== 'forbidden') {
    errors.push('normal_payload_access');
  }
  if (contract.payload_boundary?.control_side_channel !== 'required') {
    errors.push('control_side_channel');
  }
  for (const field of ['fallback', 'silent_strip', 'payload_reconstruction']) {
    if (contract.failure_policy?.[field] !== 'forbidden') errors.push(field);
  }
  if (contract.owner_rule !== 'one_owner_per_semantic') errors.push('owner_rule');
  if (!Array.isArray(contract.dependencies) || contract.dependencies.length !== 4) {
    errors.push('dependencies');
  }
  if (
    !Array.isArray(contract.tasks)
    || contract.tasks.some(
      (task) => !Array.isArray(task?.required_gates) || task.required_gates.length === 0,
    )
  ) {
    errors.push('task_gates');
  }
  return errors;
}

test('M11 contract positive lane and dependency binding', () => {
  assert.equal(fs.existsSync(contractPath), true, 'M11 contract is missing');
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  assert.deepEqual(contractErrors(contract), []);
});

test('M11 contract red rejects payload/control fallback bypass', () => {
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const invalid = structuredClone(contract);
  invalid.payload_boundary.normal_payload_access = 'allowed';
  invalid.payload_boundary.control_side_channel = 'optional';
  invalid.failure_policy.fallback = 'allowed';
  invalid.failure_policy.silent_strip = 'allowed';
  invalid.failure_policy.payload_reconstruction = 'allowed';
  assert.deepEqual(contractErrors(invalid), [
    'normal_payload_access',
    'control_side_channel',
    'fallback',
    'silent_strip',
    'payload_reconstruction',
  ]);
});
