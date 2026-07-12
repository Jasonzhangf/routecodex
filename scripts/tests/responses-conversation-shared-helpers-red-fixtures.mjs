import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const root = process.cwd();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-responses-shared-helper-'));

const baseFunctionMap = YAML.parse(fs.readFileSync(path.join(root, 'docs/architecture/function-map.yml'), 'utf8'));
const baseVerificationMap = YAML.parse(fs.readFileSync(path.join(root, 'docs/architecture/verification-map.yml'), 'utf8'));
const basePackageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const nestedKeyHelper = ['args', 'contain', 'direct', 'or', 'nested', 'key'].join('_');

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

function sharedHelperSource() {
  return `
use serde_json::{Map, Value};

pub(crate) fn ${nestedKeyHelper}(args: &Map<String, Value>, key: &str) -> bool {
    if args.contains_key(key) {
        return true;
    }
    ["input", "args"].iter().any(|container_key| {
        args.get(*container_key)
            .and_then(Value::as_object)
            .map(|row| row.contains_key(key))
            .unwrap_or(false)
    })
}
`;
}

function consumerSource() {
  return `
use crate::shared_json_utils::${nestedKeyHelper};
use serde_json::{Map, Value};

pub(crate) fn use_shared(args: &Map<String, Value>) -> bool {
    ${nestedKeyHelper}(args, "cmd")
}
`;
}

function seedCleanFixture() {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  writeFile(
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_json_utils.rs',
    sharedHelperSource()
  );
  writeFile(
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs',
    consumerSource()
  );
  writeFile(
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/exec_command_args.rs',
    consumerSource()
  );
  writeFile(
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/tool_args.rs',
    consumerSource()
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
    ROUTECODEX_RESPONSES_HELPER_SCAN_ROOT: tmpRoot,
    ROUTECODEX_FUNCTION_MAP_PATH: writeYaml(`${name}/function-map.yml`, functionMap),
    ROUTECODEX_VERIFICATION_MAP_PATH: writeYaml(`${name}/verification-map.yml`, verificationMap),
    ROUTECODEX_PACKAGE_JSON_PATH: writeJson(`${name}/package.json`, packageJson),
  };

  const result = spawnSync(
    process.execPath,
    ['scripts/architecture/verify-responses-conversation-shared-helpers.mjs'],
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
  runVerifier('responses-local-helper-reintroduced', () => {
    writeFile(
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs',
      `${consumerSource()}\nfn ${nestedKeyHelper}(_: &Map<String, Value>, _: &str) -> bool { true }\n`
    );
  }, 'reintroduced local duplicate args_contain_direct_or_nested_key helper'),

  runVerifier('exec-command-local-helper-reintroduced', () => {
    writeFile(
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/exec_command_args.rs',
      `${consumerSource()}\npub(crate) fn ${nestedKeyHelper}(_: &Map<String, Value>, _: &str) -> bool { true }\n`
    );
  }, 'reintroduced local duplicate args_contain_direct_or_nested_key helper'),

  runVerifier('missing-function-map-owner', ({ functionMap }) => {
    functionMap.owners = functionMap.owners.filter(
      (row) => row.feature_id !== 'hub.responses_conversation_shared_helpers'
    );
  }, 'function-map missing feature_id'),

  runVerifier('missing-package-script', ({ packageJson }) => {
    delete packageJson.scripts['verify:responses-conversation-shared-helpers'];
  }, 'package.json missing script'),
];

console.log('[test:responses-conversation-shared-helpers-red-fixtures] ok');
for (const name of cases) console.log(`- ${name}`);
