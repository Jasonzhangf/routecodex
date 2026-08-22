import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const root = process.cwd();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-servertool-core-shared-helper-'));

const baseFunctionMap = YAML.parse(fs.readFileSync(path.join(root, 'docs/architecture/function-map.yml'), 'utf8'));
const baseVerificationMap = YAML.parse(fs.readFileSync(path.join(root, 'docs/architecture/verification-map.yml'), 'utf8'));
const basePackageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeFile(relPath, content) {
  const absPath = path.join(tmpRoot, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf8');
}

function writeYaml(relPath, value) {
  const absPath = path.join(tmpRoot, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, YAML.stringify(value), 'utf8');
  return absPath;
}

function writeJson(relPath, value) {
  const absPath = path.join(tmpRoot, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return absPath;
}

function sharedJsonSource() {
  const parseHelper = ['parse_json', 'with_context'].join('_');
  const stringifyHelper = ['stringify_json', 'with_context'].join('_');
  return `
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{Map, Value};

pub(crate) fn ${parseHelper}<T: DeserializeOwned>(
    input_json: &str,
    context: &str,
) -> Result<T, String> {
    serde_json::from_str(input_json).map_err(|error| format!("{context}: {error}"))
}

pub(crate) fn ${stringifyHelper}<T: Serialize>(
    value: &T,
    context: &str,
) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("{context}: {error}"))
}
`;
}

function servertoolSource({ parseUses = 85, stringifyUses = 55, localParses = 0 } = {}) {
  const lines = [
    'use crate::shared_json_utils::{parse_json_with_context, stringify_json_with_context};',
    'pub fn fixture(input_json: &str) -> Result<String, String> {',
    'let input: serde_json::Value = parse_json_with_context(input_json, "deserialize fixture")?;',
    'stringify_json_with_context(&input, "serialize fixture")',
    '}',
  ];
  for (let index = 0; index < parseUses; index += 1) {
    lines.push(`fn parse_use_${index}(input_json: &str) -> Result<serde_json::Value, String> { parse_json_with_context(input_json, "deserialize parse ${index}") }`);
  }
  for (let index = 0; index < stringifyUses; index += 1) {
    lines.push(`fn stringify_use_${index}(value: &serde_json::Value) -> Result<String, String> { stringify_json_with_context(value, "serialize value ${index}") }`);
  }
  for (let index = 0; index < localParses; index += 1) {
    lines.push(`fn local_parse_${index}(input_json: &str) -> Result<serde_json::Value, String> { serde_json::from_str(input_json).map_err(|e| format!("deserialize local ${index}: {e}")) }`);
  }
  return `${lines.join('\n')}\n`;
}

function seedCleanFixture() {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  writeFile(
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_json_utils.rs',
    sharedJsonSource()
  );
  writeFile(
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs',
    servertoolSource()
  );
}

function runVerifier(name, mutate, expectedSubstring) {
  seedCleanFixture();
  const functionMap = clone(baseFunctionMap);
  const verificationMap = clone(baseVerificationMap);
  const packageJson = clone(basePackageJson);
  mutate({ functionMap, verificationMap, packageJson });

  const env = {
    ...process.env,
    ROUTECODEX_SERVERTOOL_CORE_HELPER_SCAN_ROOT: tmpRoot,
    ROUTECODEX_FUNCTION_MAP_PATH: writeYaml(`${name}/function-map.yml`, functionMap),
    ROUTECODEX_VERIFICATION_MAP_PATH: writeYaml(`${name}/verification-map.yml`, verificationMap),
    ROUTECODEX_PACKAGE_JSON_PATH: writeJson(`${name}/package.json`, packageJson),
  };

  const result = spawnSync(
    process.execPath,
    ['scripts/architecture/verify-servertool-core-shared-helpers.mjs'],
    { cwd: root, env, encoding: 'utf8' }
  );
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0) {
    throw new Error(`${name}: expected verifier failure, got success\n${output}`);
  }
  if (!output.includes(expectedSubstring)) {
    throw new Error(`${name}: expected output containing ${JSON.stringify(expectedSubstring)}\n${output}`);
  }
  return name;
}

const cases = [
  runVerifier('servertool-local-parse-wrappers-reintroduced', () => {
    writeFile(
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs',
      servertoolSource({ localParses: 36 })
    );
  }, 'too many local contextual parse wrappers remain'),

  runVerifier('servertool-shared-helper-removed', () => {
    writeFile(
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_json_utils.rs',
      'use serde_json::{Map, Value};\n'
    );
  }, 'missing shared parse_json_with_context helper'),

  runVerifier('missing-function-map-owner', ({ functionMap }) => {
    functionMap.owners = functionMap.owners.filter(
      (row) => row.feature_id !== 'hub.servertool_core_shared_helpers'
    );
  }, 'function-map missing feature_id'),

  runVerifier('missing-package-script', ({ packageJson }) => {
    delete packageJson.scripts['verify:servertool-core-shared-helpers'];
  }, 'package.json missing script'),
];

console.log('[test:servertool-core-shared-helpers-red-fixtures] ok');
for (const name of cases) console.log(`- ${name}`);
