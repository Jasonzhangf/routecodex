#!/usr/bin/env node
/**
 * v4_parity_gate_v3_resource_coverage (ABS-GATE-01)
 *
 * Machine-truth gate for the six-axis abstraction coverage matrix
 * (v4/docs/architecture/v4-v3-abstraction-coverage.yml):
 * 1. Covers all 103 v3 resources exactly once (no missing / extra / duplicate).
 * 2. Every entry has axis in {information, data, control, diagnostic},
 *    non-empty operator_kind and status != unclassified.
 * 3. Every entry's axis/operator_kind matches the kind_rules classification
 *    for its v3 resource_kind (kind rules are complete in both directions).
 * 4. Axis counts match the coverage matrix and the declared evaluation in
 *    pipeline-abstraction.contract.json (23 / 22 / 44 / 14 = 103, gap=0).
 * 5. Parity map coverage claim v3_resources total=103 mapped=103 gap=0.
 *
 * Run with --red-self-test to prove the gate fails on each negative class.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = process.cwd();
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const readYaml = (file) => yaml.load(fs.readFileSync(path.join(root, file), 'utf8'));

const VALID_AXES = ['information', 'data', 'control', 'diagnostic'];
const EXPECTED_AXIS_COUNTS = { information: 23, data: 22, control: 44, diagnostic: 14 };

function validate(v3Map, coverage, parity, abstractionContract) {
  const failures = [];
  const v3ById = new Map((v3Map.resources ?? []).map((resource) => [resource.resource_id, resource.resource_kind]));
  const coveredById = new Map((coverage.resources ?? []).map((entry) => [entry.resource_id, entry]));

  if (v3Map.resources.length !== 103) {
    failures.push(`v3 resource map count=${v3Map.resources.length} (must be 103)`);
  }
  if (coverage.resources.length !== 103) {
    failures.push(`coverage matrix count=${coverage.resources.length} (must be 103)`);
  }

  for (const id of v3ById.keys()) {
    if (!coveredById.has(id)) {
      failures.push(`v3 resource ${id} not covered in v4-v3-abstraction-coverage.yml`);
    }
  }
  for (const id of coveredById.keys()) {
    if (!v3ById.has(id)) {
      failures.push(`coverage declares unknown v3 resource ${id}`);
    }
  }
  if (new Set(coveredById.keys()).size !== coveredById.size) {
    failures.push('coverage matrix contains duplicate resource_id');
  }

  const kindRules = coverage.kind_rules ?? {};
  for (const kind of new Set(v3ById.values())) {
    if (!kindRules[kind]) {
      failures.push(`v3 resource_kind ${kind} has no kind_rule`);
    }
  }
  for (const kind of Object.keys(kindRules)) {
    if (!new Set(v3ById.values()).has(kind)) {
      failures.push(`kind_rule for ${kind} has no v3 resource of that kind`);
    }
  }

  const counts = { information: 0, data: 0, control: 0, diagnostic: 0 };
  for (const entry of coverage.resources ?? []) {
    const kind = v3ById.get(entry.resource_id);
    if (!VALID_AXES.includes(entry.axis)) {
      failures.push(`${entry.resource_id}: axis ${entry.axis} not in ${VALID_AXES.join('|')}`);
    }
    if (!entry.operator_kind) {
      failures.push(`${entry.resource_id}: missing operator_kind`);
    }
    if (entry.status === 'unclassified') {
      failures.push(`${entry.resource_id}: status unclassified`);
    }
    const rule = kindRules[kind];
    if (rule && (rule[0] !== entry.axis || rule[1] !== entry.operator_kind)) {
      failures.push(
        `${entry.resource_id}: classified ${entry.axis}/${entry.operator_kind} but kind_rule ${kind} requires ${rule[0]}/${rule[1]}`,
      );
    }
    if (VALID_AXES.includes(entry.axis)) {
      counts[entry.axis] += 1;
    }
  }
  for (const [axis, expected] of Object.entries(EXPECTED_AXIS_COUNTS)) {
    if (counts[axis] !== expected) {
      failures.push(`axis ${axis} count=${counts[axis]} (must be ${expected})`);
    }
    if (coverage.axis_counts?.[axis] !== expected) {
      failures.push(`coverage.axis_counts.${axis}=${coverage.axis_counts?.[axis]} (must be ${expected})`);
    }
  }

  const contractCoverage = abstractionContract.evaluation?.coverage_v3_resources;
  if (!contractCoverage || contractCoverage.total !== 103 || contractCoverage.unclassified !== 0) {
    failures.push(
      `pipeline-abstraction evaluation.coverage_v3_resources inconsistent (total=${contractCoverage?.total}, unclassified=${contractCoverage?.unclassified})`,
    );
  }
  if (
    contractCoverage.information !== 23 ||
    contractCoverage.data !== 22 ||
    contractCoverage.control !== 44 ||
    contractCoverage.diagnostic_sub_axis !== 14
  ) {
    failures.push('pipeline-abstraction evaluation axis counts differ from coverage matrix');
  }

  const parityCoverage = parity.coverage?.v3_resources;
  if (!parityCoverage || parityCoverage.total !== 103 || parityCoverage.mapped !== 103 || parityCoverage.gap !== 0) {
    failures.push(
      `parity map coverage.v3_resources inconsistent (total=${parityCoverage?.total}, mapped=${parityCoverage?.mapped}, gap=${parityCoverage?.gap})`,
    );
  }
  return failures;
}

function runSelfTest() {
  const v3Map = readYaml('docs/architecture/v3-resource-operation-map.yml');
  const baseCoverage = readYaml('v4/docs/architecture/v4-v3-abstraction-coverage.yml');
  const parity = readYaml('v4/docs/architecture/v3-v4-semantic-parity-map.yml');
  const contract = readJson('v4/contracts/pipeline-abstraction.contract.json');
  const clone = (value) => JSON.parse(JSON.stringify(value));

  const cases = [
    ['unclassified status', (c) => {
      c.resources[0].status = 'unclassified';
    }],
    ['extra resource', (c) => {
      c.resources.push({ resource_id: 'v3.unknown.extra', axis: 'data', operator_kind: 'normalize', status: 'classified' });
    }],
    ['missing resource', (c) => {
      c.resources = c.resources.slice(1);
    }],
    ['axis vs kind rule mismatch', (c) => {
      c.resources[0].axis = 'data';
    }],
  ];

  let failed = 0;
  for (const [name, mutate] of cases) {
    const coverage = clone(baseCoverage);
    mutate(coverage);
    const failures = validate(v3Map, coverage, parity, contract);
    if (failures.length === 0) {
      console.error(`[v4_parity_gate_v3_resource_coverage] red self-test ${name}: expected FAIL, got PASS`);
      failed += 1;
    } else {
      console.log(`[v4_parity_gate_v3_resource_coverage] red self-test ${name}: FAIL as expected (${failures.length})`);
    }
  }
  if (failed > 0) {
    process.exit(1);
  }
  console.log(`[v4_parity_gate_v3_resource_coverage] OK red self-test ${cases.length}/${cases.length}`);
}

if (process.argv.includes('--red-self-test')) {
  runSelfTest();
  process.exit(0);
}

const v3Map = readYaml('docs/architecture/v3-resource-operation-map.yml');
const coverage = readYaml('v4/docs/architecture/v4-v3-abstraction-coverage.yml');
const parity = readYaml('v4/docs/architecture/v3-v4-semantic-parity-map.yml');
const contract = readJson('v4/contracts/pipeline-abstraction.contract.json');
const failures = validate(v3Map, coverage, parity, contract);
if (failures.length > 0) {
  console.error('[v4_parity_gate_v3_resource_coverage] FAIL');
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('[v4_parity_gate_v3_resource_coverage] OK coverage=103/103 gap=0 axes=23/22/44/14');
