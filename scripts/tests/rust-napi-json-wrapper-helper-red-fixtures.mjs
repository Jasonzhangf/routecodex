import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const root = process.cwd();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-rust-napi-json-helper-'));

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

function cleanHelperSource() {
  const parseHelperName = 'parse_napi_json';
  const stringifyHelperName = 'stringify_napi_json';
  return `
use napi::bindgen_prelude::Result as NapiResult;
use serde::{de::DeserializeOwned, Serialize};

pub(crate) fn ${parseHelperName}<T: DeserializeOwned>(input_json: &str) -> NapiResult<T> {
    serde_json::from_str(input_json).map_err(|error| napi::Error::from_reason(error.to_string()))
}

pub(crate) fn ${stringifyHelperName}<T: Serialize>(value: &T) -> NapiResult<String> {
    serde_json::to_string(value).map_err(|error| napi::Error::from_reason(error.to_string()))
}
`;
}

function cleanLibSource() {
  return `
mod napi_json;
use napi_json::{parse_napi_json, stringify_napi_json};
use napi::bindgen_prelude::Result as NapiResult;
use serde_json::Value;

pub fn resolve_virtual_router_routing_state_key_json(input_json: String) -> NapiResult<String> {
    let input: Value = parse_napi_json(&input_json)?;
    stringify_napi_json(&input)
}

pub fn evaluate_singleton_route_pool_exhaustion_json(input_json: String) -> NapiResult<String> {
    let input: Value = parse_napi_json(&input_json)?;
    stringify_napi_json(&input)
}

pub fn resolve_error_err05_route_availability_decision_json(input_json: String) -> NapiResult<String> {
    let input: Value = parse_napi_json(&input_json)?;
    stringify_napi_json(&input)
}

pub fn analyze_pending_tool_sync_json(input_json: String) -> NapiResult<String> {
    let input: Value = parse_napi_json(&input_json)?;
    stringify_napi_json(&input)
}

pub fn analyze_chat_process_media_json(input_json: String) -> NapiResult<String> {
    let input: Value = parse_napi_json(&input_json)?;
    stringify_napi_json(&input)
}

pub fn parse_routing_instructions_json(input_json: String) -> NapiResult<String> {
    let input: Value = parse_napi_json(&input_json)?;
    stringify_napi_json(&input)
}

pub fn apply_routing_instructions_json(input_json: String) -> NapiResult<String> {
    let input: Value = parse_napi_json(&input_json)?;
    stringify_napi_json(&input)
}

pub fn extra_one(input_json: String) -> NapiResult<String> {
    let input: Value = parse_napi_json(&input_json)?;
    stringify_napi_json(&input)
}

pub fn extra_two(input_json: String) -> NapiResult<String> {
    let input: Value = parse_napi_json(&input_json)?;
    stringify_napi_json(&input)
}

pub fn extra_three(input_json: String) -> NapiResult<String> {
    let input: Value = parse_napi_json(&input_json)?;
    stringify_napi_json(&input)
}
`;
}

function seedCleanFixture() {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  writeFile(
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/napi_json.rs',
    cleanHelperSource()
  );
  writeFile(
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
    cleanLibSource()
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
    ROUTECODEX_RUST_NAPI_JSON_SCAN_ROOT: tmpRoot,
    ROUTECODEX_FUNCTION_MAP_PATH: writeYaml(`${name}/function-map.yml`, functionMap),
    ROUTECODEX_VERIFICATION_MAP_PATH: writeYaml(`${name}/verification-map.yml`, verificationMap),
    ROUTECODEX_PACKAGE_JSON_PATH: writeJson(`${name}/package.json`, packageJson),
  };

  const result = spawnSync(
    process.execPath,
    ['scripts/architecture/verify-rust-napi-json-wrapper-helper.mjs'],
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
  runVerifier('missing-helper-module', () => {
    fs.rmSync(path.join(tmpRoot, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/napi_json.rs'));
  }, 'missing Rust NAPI JSON helper'),

  runVerifier('local-serde-wrapper-reintroduced', () => {
    writeFile(
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
      cleanLibSource().replace(
        'let input: Value = parse_napi_json(&input_json)?;\n    stringify_napi_json(&input)',
        'let input: Value = serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;\n    serde_json::to_string(&input).map_err(|e| napi::Error::from_reason(e.to_string()))'
      )
    );
  }, 'must not carry local serde_json parse/stringify wrappers'),

  runVerifier('missing-function-map-owner', ({ functionMap }) => {
    functionMap.owners = functionMap.owners.filter(
      (row) => row.feature_id !== 'hub.rust_napi_json_wrapper_helper'
    );
  }, 'function-map missing feature_id'),

  runVerifier('missing-package-script', ({ packageJson }) => {
    delete packageJson.scripts['verify:rust-napi-json-wrapper-helper'];
  }, 'package.json missing script'),
];

console.log('[test:rust-napi-json-wrapper-helper-red-fixtures] ok');
for (const name of cases) console.log(`- ${name}`);
