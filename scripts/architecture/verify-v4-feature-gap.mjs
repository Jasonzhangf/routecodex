#!/usr/bin/env node
/**
 * v4_parity_gate_feature_gap (ABS-GATE-02)
 *
 * Machine-truth gate for feature-level V3/V4 abstraction closure
 * (v4-pipeline-abstraction-model.md completeness gate 2):
 * 1. V3 function map features and v4-v3-feature-mapping.yml are exact sets
 *    (no missing / extra / duplicate).
 * 2. The actual v3 feature set must equal the frozen independent baseline
 *    (v4/contracts/v3-feature-baseline.json): coordinated removal across all
 *    four live sources without an explicit baseline change must fail.
 * 3. Every feature has a chain from the contract operator_schema chains and at
 *    least one operator_kind from the six-axis operator vocabulary
 *    (v4-v3-abstraction-coverage.yml kind_rules values).
 * 4. status=gap counts as GAP; GAP must be 0 before entering implementation.
 * 5. coverage.features in the mapping file, parity map coverage.features, and
 *    pipeline-abstraction.contract.json evaluation.coverage_v3_features all
 *    agree with the actual v3 feature count and gap=0.
 *
 * Run with --red-self-test to prove the gate fails on each negative class.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = process.cwd();

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    console.error(`[v4_parity_gate_feature_gap] ${file}: cannot read/parse: ${error.message}`);
    return null;
  }
};

const readYaml = (file) => {
  try {
    return yaml.load(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    console.error(`[v4_parity_gate_feature_gap] ${file}: cannot read/parse: ${error.message}`);
    return null;
  }
};

function validate(v3Features, mapping, coverage, parity, contract, baseline) {
  const failures = [];
  const v3Ids = (v3Features ?? []).map((feature) => feature.feature_id);
  const entries = mapping.features ?? [];
  const mapIds = entries.map((entry) => entry.feature_id);
  const v3Set = new Set(v3Ids);
  const actual = v3Ids.length;

  const baselineIds = baseline?.feature_ids ?? [];
  const baselineSet = new Set(baselineIds);
  if (baseline?.total !== baselineIds.length || baselineIds.length === 0) {
    failures.push(
      `v3 feature baseline inconsistent (total=${baseline?.total}, ids=${baselineIds.length}; must match and be non-empty)`,
    );
  } else if (baselineSet.size !== baselineIds.length) {
    failures.push('v3 feature baseline contains duplicate feature_id');
  }
  for (const id of baselineSet) {
    if (!v3Set.has(id)) {
      failures.push(`frozen baseline feature ${id} missing from v3 function map (coordinated collapse detected)`);
    }
  }
  for (const id of v3Set) {
    if (!baselineSet.has(id)) {
      failures.push(`v3 function map feature ${id} not in frozen baseline`);
    }
  }

  if (new Set(mapIds).size !== mapIds.length) {
    failures.push('feature mapping contains duplicate feature_id');
  }
  for (const id of v3Set) {
    if (!mapIds.includes(id)) {
      failures.push(`v3 feature ${id} not mapped in v4-v3-feature-mapping.yml`);
    }
  }
  for (const id of mapIds) {
    if (!v3Set.has(id)) {
      failures.push(`feature mapping declares unknown v3 feature ${id}`);
    }
  }
  if (mapIds.length !== actual) {
    failures.push(`feature mapping count=${mapIds.length} but v3 function map has ${actual}`);
  }

  const operatorVocab = new Set(Object.values(coverage.kind_rules ?? {}).map((rule) => rule[1]));
  const chains = new Set(contract.operator_schema?.chains ?? []);
  let mapped = 0;
  let gap = 0;
  for (const entry of entries) {
    if (!chains.has(entry.chain)) {
      failures.push(`${entry.feature_id}: chain ${entry.chain} not in ${[...chains].join('|')}`);
    }
    if (!Array.isArray(entry.operator_kinds) || entry.operator_kinds.length === 0) {
      failures.push(`${entry.feature_id}: missing operator_kinds`);
    } else {
      for (const op of entry.operator_kinds) {
        if (!operatorVocab.has(op)) {
          failures.push(`${entry.feature_id}: operator_kind ${op} not in six-axis vocabulary`);
        }
      }
    }
    if (entry.status === 'mapped') {
      mapped += 1;
    } else if (entry.status === 'gap') {
      gap += 1;
    } else {
      failures.push(`${entry.feature_id}: status ${entry.status} not in mapped|gap`);
    }
  }

  const mappingCoverage = mapping.coverage?.features;
  if (!mappingCoverage || mappingCoverage.total !== actual || mappingCoverage.mapped !== mapped || mappingCoverage.gap !== gap) {
    failures.push(
      `feature mapping coverage inconsistent (total=${mappingCoverage?.total}, mapped=${mappingCoverage?.mapped}, gap=${mappingCoverage?.gap}; actual=${actual}/${mapped}/${gap})`,
    );
  }
  if (mapped !== actual || gap !== 0) {
    failures.push(`feature coverage mapped=${mapped} gap=${gap} (must be ${actual}/0)`);
  }

  const parityCoverage = parity.coverage?.features;
  if (!parityCoverage || parityCoverage.total !== actual || parityCoverage.mapped !== actual || parityCoverage.gap !== 0) {
    failures.push(
      `parity map coverage.features inconsistent (total=${parityCoverage?.total}, mapped=${parityCoverage?.mapped}, gap=${parityCoverage?.gap}; must be ${actual}/${actual}/0)`,
    );
  }

  const contractFeatures = contract.evaluation?.coverage_v3_features;
  if (!contractFeatures || contractFeatures.total !== actual || contractFeatures.gaps !== 0) {
    failures.push(
      `pipeline-abstraction evaluation.coverage_v3_features inconsistent (total=${contractFeatures?.total}, gaps=${contractFeatures?.gaps}; must be ${actual}/0)`,
    );
  }
  return failures;
}

function loadInputs() {
  const v3Map = readYaml('docs/architecture/v3-function-map.yml');
  const mapping = readYaml('v4/docs/architecture/v4-v3-feature-mapping.yml');
  const coverage = readYaml('v4/docs/architecture/v4-v3-abstraction-coverage.yml');
  const parity = readYaml('v4/docs/architecture/v3-v4-semantic-parity-map.yml');
  const contract = readJson('v4/contracts/pipeline-abstraction.contract.json');
  const baseline = readJson('v4/contracts/v3-feature-baseline.json');
  if (!v3Map || !mapping || !coverage || !parity || !contract || !baseline) {
    console.error('[v4_parity_gate_feature_gap] FAIL: input source unreadable');
    process.exit(1);
  }
  return { v3Features: v3Map.features ?? [], mapping, coverage, parity, contract, baseline };
}

function runSelfTest() {
  const { v3Features, mapping, coverage, parity, contract, baseline } = loadInputs();
  const clone = (value) => JSON.parse(JSON.stringify(value));

  const cases = [
    ['missing feature mapping', ({ mapping: m }) => {
      m.features = m.features.slice(1);
    }],
    ['extra feature mapping', ({ mapping: m }) => {
      m.features.push({ feature_id: 'v3.unknown.extra', chain: 'request', operator_kinds: ['normalize'], status: 'mapped' });
    }],
    ['duplicate feature_id', ({ mapping: m }) => {
      m.features.push(clone(m.features[0]));
    }],
    ['gap status', ({ mapping: m }) => {
      m.features[0].status = 'gap';
    }],
    ['invalid chain', ({ mapping: m }) => {
      m.features[0].chain = 'banana';
    }],
    ['operator not in vocabulary', ({ mapping: m }) => {
      m.features[0].operator_kinds = [...m.features[0].operator_kinds, 'no_such_operator'];
    }],
    ['mapping coverage drift', ({ mapping: m }) => {
      m.coverage.features.total = 63;
    }],
    ['parity drift', ({ parity: p }) => {
      p.coverage.features.gap = 1;
    }],
    ['contract drift', ({ contract: c }) => {
      c.evaluation.coverage_v3_features.total = 63;
    }],
    ['new v3 feature unmapped', ({ v3Features: v }) => {
      v.push({ feature_id: 'v3.new_unmapped_feature' });
    }],
    ['coordinated collapse across all four sources', ({ v3Features: v, mapping: m, parity: p, contract: c }) => {
      const removed = v[0].feature_id;
      v.splice(0, 1);
      m.features = m.features.filter((entry) => entry.feature_id !== removed);
      m.coverage.features.total -= 1;
      m.coverage.features.mapped -= 1;
      p.coverage.features.total -= 1;
      p.coverage.features.mapped -= 1;
      c.evaluation.coverage_v3_features.total -= 1;
    }],
  ];

  let failed = 0;
  for (const [name, mutate] of cases) {
    const inputs = {
      v3Features: clone(v3Features),
      mapping: clone(mapping),
      coverage: clone(coverage),
      parity: clone(parity),
      contract: clone(contract),
      baseline: clone(baseline),
    };
    mutate(inputs);
    const failures = validate(
      inputs.v3Features,
      inputs.mapping,
      inputs.coverage,
      inputs.parity,
      inputs.contract,
      inputs.baseline,
    );
    if (failures.length === 0) {
      console.error(`[v4_parity_gate_feature_gap] red self-test ${name}: expected FAIL, got PASS`);
      failed += 1;
    } else {
      console.log(`[v4_parity_gate_feature_gap] red self-test ${name}: FAIL as expected (${failures.length})`);
    }
  }
  if (failed > 0) {
    process.exit(1);
  }
  console.log(`[v4_parity_gate_feature_gap] OK red self-test ${cases.length}/${cases.length}`);
}

if (process.argv.includes('--red-self-test')) {
  runSelfTest();
  process.exit(0);
}

const { v3Features, mapping, coverage, parity, contract, baseline } = loadInputs();
const failures = validate(v3Features, mapping, coverage, parity, contract, baseline);
if (failures.length > 0) {
  console.error('[v4_parity_gate_feature_gap] FAIL');
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`[v4_parity_gate_feature_gap] OK features=${v3Features.length}/${v3Features.length} gap=0`);
