import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const root = process.cwd();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-resource-source-bindings-'));
const base = {
  resource: YAML.parse(fs.readFileSync(path.join(root, 'docs/architecture/resource-operation-map.yml'), 'utf8')),
  function: YAML.parse(fs.readFileSync(path.join(root, 'docs/architecture/function-map.yml'), 'utf8')),
  verification: YAML.parse(fs.readFileSync(path.join(root, 'docs/architecture/verification-map.yml'), 'utf8')),
  mainline: YAML.parse(fs.readFileSync(path.join(root, 'docs/architecture/mainline-call-map.yml'), 'utf8')),
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeYaml(name, value) {
  const relPath = path.join(tmpRoot, `${name}.yml`);
  fs.writeFileSync(relPath, YAML.stringify(value), 'utf8');
  return relPath;
}

function runCase(name, mutate, expectedSubstring) {
  const resource = clone(base.resource);
  const functionMap = clone(base.function);
  const verification = clone(base.verification);
  const mainline = clone(base.mainline);
  mutate({ resource, functionMap, verification, mainline });

  const env = {
    ...process.env,
    ROUTECODEX_RESOURCE_MAP_PATH: writeYaml(`${name}-resource`, resource),
    ROUTECODEX_FUNCTION_MAP_PATH: writeYaml(`${name}-function`, functionMap),
    ROUTECODEX_VERIFICATION_MAP_PATH: writeYaml(`${name}-verification`, verification),
    ROUTECODEX_MAINLINE_MAP_PATH: writeYaml(`${name}-mainline`, mainline),
  };
  const result = spawnSync(
    process.execPath,
    ['scripts/architecture/verify-resource-source-bindings.mjs'],
    { cwd: root, env, encoding: 'utf8' }
  );
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0) {
    throw new Error(`${name}: expected verifier failure, got success\n${output}`);
  }
  if (!output.includes(expectedSubstring)) {
    throw new Error(`${name}: expected failure containing ${JSON.stringify(expectedSubstring)}\n${output}`);
  }
  return name;
}

const cases = [
  runCase('missing-owner-feature', ({ resource }) => {
    resource.resources[0].owner_feature_id = 'fixture.missing_owner_feature';
  }, 'owner_feature_id not found in function-map'),

  runCase('undeclared-resource-binding', ({ functionMap }) => {
    functionMap.owners[0].resource_bindings.reads.push('fixture.undeclared_resource@FixtureNode');
  }, 'resource_bindings.reads references undeclared resource fixture.undeclared_resource'),

  runCase('missing-source-anchor', ({ functionMap }) => {
    const owner = functionMap.owners.find((row) => row.feature_id === base.resource.resources[0].owner_feature_id);
    owner.owner_module = 'package.json';
    owner.allowed_paths = ['package.json'];
  }, 'missing source anchor'),

  runCase('missing-required-gate', ({ resource }) => {
    resource.resources[0].required_gates = ['npm run verify:fixture-missing-gate'];
  }, 'required gate script missing in package.json: verify:fixture-missing-gate'),

  runCase('side-channel-enters-provider-body', ({ resource }) => {
    const sideChannel = resource.resources.find((row) => row.resource_kind === 'side_channel');
    sideChannel.may_enter_provider_body = true;
  }, 'side_channel resource may_enter_provider_body must be false'),

  runCase('forbidden-writer-overlap', ({ resource }) => {
    resource.resources[0].forbidden_writers.push(resource.resources[0].allowed_writers[0]);
  }, 'forbidden_writers overlaps allowed_writers'),

  runCase('fake-non-adjacent-mainline-flow', ({ resource }) => {
    resource.mainline_resource_flows.push({
      chain_id: 'fixture.fake_chain',
      step_id: 'fixture-fake-step',
      consumes: ['request.normal_payload'],
      produces: [],
      side_channel_reads: [],
      side_channel_writes: [],
    });
  }, 'fake/non-adjacent mainline flow'),
];

console.log('[test:resource-source-bindings-red-fixtures] ok');
for (const name of cases) console.log(`- ${name}`);
