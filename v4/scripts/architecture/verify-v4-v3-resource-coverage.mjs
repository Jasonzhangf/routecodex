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
 * 6. Six-axis plane isolation invariants (v4-pipeline-abstraction-model.md):
 *    - control axis: may_enter_provider_body=false and may_enter_client_body=false
 *      (all V3 control resources, including v3.error.client_projection: the
 *      V4-level v4.error.client_projection is the sanctioned control->client
 *      projection and is enforced by verify-v4-plane-isolation.mjs instead);
 *    - data axis: no control/diagnostic owner may be an allowed writer
 *      (control fields and debug-snapshot rebuild must never enter data payload);
 *    - diagnostic axis: may_enter_provider_body=false and may_enter_client_body=false,
 *      and no live-path owner in allowed_readers except registered projections:
 *      v3.debug.dry_run_execution -> V3Server16HttpFrame,
 *      v3.runtime.responses_timing_observability ->
 *      V3ResponsesProtocolRelayHandoff / V3ResponsesProtocolDirectHandoff.
 *
 * Run with --red-self-test to prove the gate fails on each negative class.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';
import { loadV3Baseline } from './_v3-baseline.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const readJson = (file) => {
  try {
    const full = path.isAbsolute(file) ? file : path.join(root, file);
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (error) {
    console.error(`[v4_parity_gate_v3_resource_coverage] ${file}: cannot read/parse: ${error.message}`);
    return null;
  }
};

const readYaml = (file) => {
  try {
    const full = path.isAbsolute(file) ? file : path.join(root, file);
    return yaml.load(fs.readFileSync(full, 'utf8'));
  } catch (error) {
    console.error(`[v4_parity_gate_v3_resource_coverage] ${file}: cannot read/parse: ${error.message}`);
    return null;
  }
};

const VALID_AXES = ['information', 'data', 'control', 'diagnostic'];
const EXPECTED_AXIS_COUNTS = { information: 23, data: 22, control: 44, diagnostic: 14 };

// Live-path owner vocabulary for the diagnostic "never read by live path" invariant.
const LIVE_OWNER_PATTERN =
  /^V3Server|^V3Router|^V3VirtualRouter|^V3Execution|^V3ResponsesDirect|^V3ResponsesProtocol|^V3Provider|^V3Transport|^V3Target|^V3Resp|^V3Req|^V3Hub|^V3Runtime|^routecodex-v3-/;

// Control/debug owner vocabulary: a data resource must never be written by these owners.
const CONTROL_DEBUG_WRITER_PATTERN =
  /^V3Router|^V3VirtualRouter|^V3Execution|^V3ResponsesDirect|^V3Error|^V3Control|^V3Scope|^V3Target|^V3Debug|^V3HubReqContinuation|^V3HubRespContinuation|^V3ProviderAction|^MetadataCenter/;

// Registered diagnostic -> live-path projections (six-axis invariant clause 3).
const DIAGNOSTIC_LIVE_READER_EXCEPTIONS = {
  'v3.debug.dry_run_execution': ['V3Server16HttpFrame'],
  'v3.runtime.responses_timing_observability': ['V3ResponsesProtocolRelayHandoff', 'V3ResponsesProtocolDirectHandoff'],
};

function validate(v3Map, coverage, parity, abstractionContract) {
  const failures = [];
  const v3ById = new Map((v3Map.resources ?? []).map((resource) => [resource.resource_id, resource]));
  const v3Kinds = new Set((v3Map.resources ?? []).map((resource) => resource.resource_kind));
  const coveredIds = (coverage.resources ?? []).map((entry) => entry.resource_id);
  const coveredById = new Map(coveredIds.map((id, index) => [id, coverage.resources[index]]));

  if (v3Map.resources.length !== 103) {
    failures.push(`v3 resource map count=${v3Map.resources.length} (must be 103)`);
  }
  if (coverage.resources.length !== 103) {
    failures.push(`coverage matrix count=${coverage.resources.length} (must be 103)`);
  }
  if (new Set(coveredIds).size !== coveredIds.length) {
    failures.push('coverage matrix contains duplicate resource_id');
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

  const kindRules = coverage.kind_rules ?? {};
  for (const kind of v3Kinds) {
    if (!kindRules[kind]) {
      failures.push(`v3 resource_kind ${kind} has no kind_rule`);
    }
  }
  for (const kind of Object.keys(kindRules)) {
    if (!v3Kinds.has(kind)) {
      failures.push(`kind_rule for ${kind} has no v3 resource of that kind`);
    }
  }

  const counts = { information: 0, data: 0, control: 0, diagnostic: 0 };
  for (const entry of coverage.resources ?? []) {
    const resource = v3ById.get(entry.resource_id);
    if (!VALID_AXES.includes(entry.axis)) {
      failures.push(`${entry.resource_id}: axis ${entry.axis} not in ${VALID_AXES.join('|')}`);
    }
    if (!entry.operator_kind) {
      failures.push(`${entry.resource_id}: missing operator_kind`);
    }
    if (entry.status === 'unclassified') {
      failures.push(`${entry.resource_id}: status unclassified`);
    }
    const rule = kindRules[resource?.resource_kind];
    if (rule && (rule[0] !== entry.axis || rule[1] !== entry.operator_kind)) {
      failures.push(
        `${entry.resource_id}: classified ${entry.axis}/${entry.operator_kind} but kind_rule ${resource.resource_kind} requires ${rule[0]}/${rule[1]}`,
      );
    }
    if (!resource) {
      continue; // unknown resource_id already reported above
    }

    // Six-axis plane isolation invariants (v4-pipeline-abstraction-model.md clause 3).
    if (entry.axis === 'control') {
      if (resource.may_enter_provider_body !== false || resource.may_enter_client_body !== false) {
        failures.push(`${entry.resource_id}: control axis resource must never enter provider/client body`);
      }
    }
    if (entry.axis === 'data') {
      const controlWriter = (resource.allowed_writers ?? []).find((writer) => CONTROL_DEBUG_WRITER_PATTERN.test(writer));
      if (controlWriter) {
        failures.push(`${entry.resource_id}: data axis resource has control/debug writer ${controlWriter}`);
      }
    }
    if (entry.axis === 'diagnostic') {
      if (resource.may_enter_provider_body !== false || resource.may_enter_client_body !== false) {
        failures.push(`${entry.resource_id}: diagnostic axis resource must never enter provider/client body`);
      }
      const exceptions = DIAGNOSTIC_LIVE_READER_EXCEPTIONS[entry.resource_id] ?? [];
      const liveReader = (resource.allowed_readers ?? []).find(
        (reader) => LIVE_OWNER_PATTERN.test(reader) && !exceptions.includes(reader),
      );
      if (liveReader) {
        failures.push(`${entry.resource_id}: diagnostic axis resource read by live path owner ${liveReader}`);
      }
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

function loadInputs() {
  const baselineInfo = loadV3Baseline('v3-resource-operation-map.yml');
  const v3Map = readYaml(baselineInfo.artifactPath);
  const coverage = readYaml('docs/architecture/v4-v3-abstraction-coverage.yml');
  const parity = readYaml('docs/architecture/v3-v4-semantic-parity-map.yml');
  const contract = readJson('contracts/pipeline-abstraction.contract.json');
  if (!v3Map || !coverage || !parity || !contract) {
    console.error('[v4_parity_gate_v3_resource_coverage] FAIL: input source unreadable');
    process.exit(1);
  }
  return { v3Map, coverage, parity, contract };
}

function runSelfTest() {
  const { v3Map, coverage, parity, contract } = loadInputs();
  const clone = (value) => JSON.parse(JSON.stringify(value));

  const controlId = coverage.resources.find((entry) => entry.axis === 'control').resource_id;
  const dataId = coverage.resources.find((entry) => entry.axis === 'data').resource_id;
  const diagnosticId = 'v3.debug.artifact';

  const cases = [
    ['unclassified status', ({ coverage: c }) => {
      c.resources[0].status = 'unclassified';
    }],
    ['extra resource', ({ coverage: c }) => {
      c.resources.push({ resource_id: 'v3.unknown.extra', axis: 'data', operator_kind: 'normalize', status: 'classified' });
    }],
    ['missing resource', ({ coverage: c }) => {
      c.resources = c.resources.slice(1);
    }],
    ['axis vs kind rule mismatch', ({ coverage: c }) => {
      c.resources[0].axis = 'data';
    }],
    ['duplicate resource_id', ({ coverage: c }) => {
      c.resources.push(clone(c.resources[0]));
    }],
    ['control body flag violation', ({ v3Map: v }) => {
      v.resources.find((resource) => resource.resource_id === controlId).may_enter_provider_body = true;
    }],
    ['data control/debug writer violation', ({ v3Map: v }) => {
      const resource = v.resources.find((r) => r.resource_id === dataId);
      resource.allowed_writers = [...(resource.allowed_writers ?? []), 'V3Error06ClientProjected'];
    }],
    ['diagnostic live reader violation', ({ v3Map: v }) => {
      const resource = v.resources.find((r) => r.resource_id === diagnosticId);
      resource.allowed_readers = [...(resource.allowed_readers ?? []), 'V3Server16HttpFrame'];
    }],
    ['contract drift', ({ contract: ct }) => {
      ct.evaluation.coverage_v3_resources.control = 43;
    }],
    ['parity drift', ({ parity: p }) => {
      p.coverage.v3_resources.gap = 1;
    }],
  ];

  let failed = 0;
  for (const [name, mutate] of cases) {
    const inputs = {
      v3Map: clone(v3Map),
      coverage: clone(coverage),
      parity: clone(parity),
      contract: clone(contract),
    };
    mutate(inputs);
    const failures = validate(inputs.v3Map, inputs.coverage, inputs.parity, inputs.contract);
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

const { v3Map, coverage, parity, contract } = loadInputs();
const failures = validate(v3Map, coverage, parity, contract);
if (failures.length > 0) {
  console.error('[v4_parity_gate_v3_resource_coverage] FAIL');
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('[v4_parity_gate_v3_resource_coverage] OK coverage=103/103 gap=0 axes=23/22/44/14');
