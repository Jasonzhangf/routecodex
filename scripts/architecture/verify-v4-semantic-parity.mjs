#!/usr/bin/env node
/**
 * v4_parity_gate_semantic_parity
 *
 * Locks V3/V4 semantic truth closure (Phase 1):
 * 1. Every V3 semantic stage (request/response/error/config) maps to a V4
 *    container (family/role), plugin kinds, checkpoint (node_id + semantic),
 *    resource, and verification gate.
 * 2. coverage totals in the parity map match the actual stage counts.
 * 3. Every referenced verification gate exists in verification-map.json.
 * 4. Every referenced resource exists in v4-resource-operation-map.yml.
 * 5. checkpoint evidence must exist: `pending_skeleton_vslice` is RED until
 *    Phase 4/5 supplies the minimal skeleton runtime evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

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

const readYaml = (file) => {
  try {
    return yaml.load(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    failures.push(`${file}: cannot read/parse: ${error.message}`);
    return null;
  }
};

const parity = readYaml('v4/docs/architecture/v3-v4-semantic-parity-map.yml');
const verification = readJson('v4/.appsdk/maps/verification-map.json');
const resourceMap = readYaml('v4/docs/architecture/v4-resource-operation-map.yml');

if (!parity || !verification || !resourceMap) process.exit(1);

const gateIds = new Set((verification.gates ?? []).map((gate) => gate.gate_id));
const resourceIds = new Set((resourceMap.resources ?? []).map((resource) => resource.resource_id));

const chains = parity.chains ?? {};
let actualTotal = 0;
for (const [chain, stages] of Object.entries(chains)) {
  actualTotal += stages.length;
  for (const stage of stages) {
    const id = `${chain}.${stage.v3_stage ?? '?'}`;
    if (!stage.container?.family || !stage.container?.role) {
      failures.push(`parity ${id}: missing container family/role`);
    }
    if (!Array.isArray(stage.plugins) || stage.plugins.length === 0) {
      failures.push(`parity ${id}: missing plugins`);
    }
    if (!stage.checkpoint?.node_id || !stage.checkpoint?.semantic) {
      failures.push(`parity ${id}: checkpoint must have node_id + semantic`);
    }
    if (!stage.resource) {
      failures.push(`parity ${id}: missing resource`);
    } else if (!resourceIds.has(stage.resource)) {
      failures.push(`parity ${id}: resource ${stage.resource} not in v4-resource-operation-map.yml`);
    }
    if (!Array.isArray(stage.verification_gates) || stage.verification_gates.length === 0) {
      failures.push(`parity ${id}: missing verification gates`);
    } else {
      for (const gate of stage.verification_gates) {
        if (!gateIds.has(gate)) {
          failures.push(`parity ${id}: verification gate ${gate} not in verification-map.json`);
        }
      }
    }
    const evidence = stage.checkpoint_evidence ?? '';
    if (!evidence || evidence === 'pending_skeleton_vslice') {
      failures.push(`parity ${id}: checkpoint evidence pending (${evidence || 'empty'})`);
    }
  }
}

const coverage = parity.coverage ?? {};
const expected = {
  request: coverage.request?.total ?? 0,
  response: coverage.response?.total ?? 0,
  error: coverage.error?.total ?? 0,
  config: coverage.config?.total ?? 0,
};
for (const [chain, total] of Object.entries(expected)) {
  const actual = (chains[chain] ?? []).length;
  if (actual !== total) {
    failures.push(`parity coverage: ${chain} total=${total} but actual=${actual}`);
  }
}
if (actualTotal !== (coverage.stages?.total ?? -1)) {
  failures.push(`parity coverage: stages total=${coverage.stages?.total} but actual=${actualTotal}`);
}

if (failures.length > 0) {
  console.error('[v4_parity_gate_semantic_parity] FAIL');
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(
  `[v4_parity_gate_semantic_parity] OK coverage=${actualTotal}/26 gap=0 all checkpoints evidenced`,
);
