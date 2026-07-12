import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const root = process.cwd();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-reasoning-shared-helper-'));

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

function cleanReasoningSource() {
  return `
use crate::shared_json_utils::{extract_balanced_json_candidate_at, extract_balanced_json_object_at};
use crate::shared_tool_call_id_core::clamp_responses_input_item_id;
use crate::shared_tooling::is_image_path;

pub fn use_shared_helpers(text: &str) -> bool {
    let _ = extract_balanced_json_candidate_at(text, 0, '{', '}');
    let _ = extract_balanced_json_object_at(text, 0);
    let _ = clamp_responses_input_item_id(Some(text));
    is_image_path(text)
}
`;
}

function seedCleanFixture() {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  writeFile(
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_reasoning_tool_normalizer.rs',
    cleanReasoningSource()
  );
  writeFile(
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_json_utils.rs',
    'pub(crate) fn extract_balanced_json_candidate_at(_: &str, _: usize, _: char, _: char) {}\npub(crate) fn extract_balanced_json_object_at(_: &str, _: usize) {}\n'
  );
  writeFile(
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_tooling.rs',
    'pub(crate) fn is_image_path(_: &str) -> bool { false }\n'
  );
  writeFile(
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_tool_call_id_core.rs',
    'pub(crate) fn clamp_responses_input_item_id(_: Option<&str>) -> Option<String> { None }\n'
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
    ROUTECODEX_REASONING_HELPER_SCAN_ROOT: tmpRoot,
    ROUTECODEX_FUNCTION_MAP_PATH: writeYaml(`${name}/function-map.yml`, functionMap),
    ROUTECODEX_VERIFICATION_MAP_PATH: writeYaml(`${name}/verification-map.yml`, verificationMap),
    ROUTECODEX_PACKAGE_JSON_PATH: writeJson(`${name}/package.json`, packageJson),
  };

  const result = spawnSync(
    process.execPath,
    ['scripts/architecture/verify-hub-reasoning-tool-normalizer-shared-helpers.mjs'],
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
  runVerifier('local-image-helper-reintroduced', () => {
    writeFile(
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_reasoning_tool_normalizer.rs',
      `${cleanReasoningSource()}\nfn is_image_path(_: &str) -> bool { true }\n`
    );
  }, 'reintroduced local duplicate helper fn is_image_path'),

  runVerifier('local-balanced-json-helper-reintroduced', () => {
    writeFile(
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_reasoning_tool_normalizer.rs',
      `${cleanReasoningSource()}\nfn extract_balanced_json_object_at(_: &str, _: usize) {}\n`
    );
  }, 'reintroduced local duplicate helper fn extract_balanced_json_object_at'),

  runVerifier('missing-function-map-owner', ({ functionMap }) => {
    functionMap.owners = functionMap.owners.filter(
      (row) => row.feature_id !== 'hub.reasoning_tool_normalizer_shared_helpers'
    );
  }, 'function-map missing feature_id'),

  runVerifier('missing-package-script', ({ packageJson }) => {
    delete packageJson.scripts['verify:hub-reasoning-tool-normalizer-shared-helpers'];
  }, 'package.json missing script'),
];

console.log('[test:hub-reasoning-tool-normalizer-shared-helpers-red-fixtures] ok');
for (const name of cases) console.log(`- ${name}`);
