import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const root = process.cwd();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-hub-engine-shared-helper-'));

const baseFunctionMap = YAML.parse(
  fs.readFileSync(path.join(root, 'docs/architecture/function-map.yml'), 'utf8'),
);
const baseVerificationMap = YAML.parse(
  fs.readFileSync(path.join(root, 'docs/architecture/verification-map.yml'), 'utf8'),
);
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
  const trimHelper = ['read_trimmed', 'string'].join('_');
  return `
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{Map, Value};

pub(crate) fn ${parseHelper}<T: DeserializeOwned>(
    input_json: &str,
    context: &str,
) -> Result<T, String> {
    serde_json::from_str(input_json).map_err(|error| format!("{context}: {error}"))
}

pub(crate) fn ${trimHelper}(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if raw.is_empty() {
        return None;
    }
    Some(raw)
}
`;
}

function engineSource({ localTrimWrappers = 0, localStoplessParse = false } = {}) {
  const lines = [
    'use crate::shared_json_utils::{parse_json_with_context, read_trimmed_string};',
    'use serde_json::Value;',
    'struct ExecuteHubPipelineInput;',
    'pub fn execute_hub_pipeline_json(input_json: String) -> Result<String, String> {',
    'let input: ExecuteHubPipelineInput = serde_json::from_str(&input_json)?;',
    'Ok(serde_json::to_string(&input).unwrap())',
    '}',
    'fn fixture(metadata: &Value, raw_runtime: &str, raw_projection: &str) -> Option<String> {',
    'let _a = read_trimmed_string(metadata.get("providerProtocol"));',
    'let _b = read_trimmed_string(metadata.get("clientProtocol"));',
    'let _c = read_trimmed_string(metadata.get("sessionId"));',
    'let _d = read_trimmed_string(metadata.get("conversationId"));',
    'let _e = read_trimmed_string(metadata.get("providerKey"));',
    'let _f = read_trimmed_string(metadata.get("routingPolicyGroup"));',
    'let _gateway: Value = parse_json_with_context::<Value>(raw_runtime, "inspect stop gateway signal").ok()?;',
    'let _runtime: Value = parse_json_with_context(raw_runtime, "Rust stopless response hook runtime returned invalid JSON").ok()?;',
    'let _projection: Value = parse_json_with_context(raw_projection, "Rust stopless response hook projection returned invalid JSON").ok()?;',
    'Some("ok".to_string())',
    '}',
  ];
  for (let index = 0; index < localTrimWrappers; index += 1) {
    lines.push(`fn local_trim_${index}(value: &Value) -> Option<String> { value.get("key").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string) }`);
  }
  if (localStoplessParse) {
    lines.push('fn local_stopless_parse(raw_runtime: &str) -> Result<Value, serde_json::Error> {');
    lines.push('let _ = "Rust stopless response hook runtime returned invalid JSON";');
    lines.push('serde_json::from_str(raw_runtime)');
    lines.push('}');
  }
  return `${lines.join('\n')}\n`;
}

function seedCleanFixture() {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  writeFile(
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_json_utils.rs',
    sharedJsonSource(),
  );
  writeFile(
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs',
    engineSource(),
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
    ROUTECODEX_HUB_ENGINE_HELPER_SCAN_ROOT: tmpRoot,
    ROUTECODEX_FUNCTION_MAP_PATH: writeYaml(`${name}/function-map.yml`, functionMap),
    ROUTECODEX_VERIFICATION_MAP_PATH: writeYaml(`${name}/verification-map.yml`, verificationMap),
    ROUTECODEX_PACKAGE_JSON_PATH: writeJson(`${name}/package.json`, packageJson),
  };

  const result = spawnSync(
    process.execPath,
    ['scripts/architecture/verify-hub-pipeline-engine-shared-helpers.mjs'],
    { cwd: root, env, encoding: 'utf8' },
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
  runVerifier(
    'engine-local-trim-wrapper-reintroduced',
    () => {
      writeFile(
        'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs',
        engineSource({ localTrimWrappers: 13 }),
      );
    },
    'too many local trimmed-string wrappers remain',
  ),

  runVerifier(
    'engine-stopless-local-json-parse-reintroduced',
    () => {
      writeFile(
        'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs',
        engineSource({ localStoplessParse: true }),
      );
    },
    'stopless runtime/projection JSON parse must use parse_json_with_context',
  ),

  runVerifier(
    'engine-shared-helper-removed',
    () => {
      writeFile(
        'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_json_utils.rs',
        'use serde_json::{Map, Value};\n',
      );
    },
    'missing shared parse_json_with_context helper',
  ),

  runVerifier(
    'missing-function-map-owner',
    ({ functionMap }) => {
      functionMap.owners = functionMap.owners.filter(
        (row) => row.feature_id !== 'hub.pipeline_engine_shared_helpers',
      );
    },
    'function-map missing feature_id',
  ),

  runVerifier(
    'missing-package-script',
    ({ packageJson }) => {
      delete packageJson.scripts['verify:hub-pipeline-engine-shared-helpers'];
    },
    'package.json missing script',
  ),
];

console.log('[test:hub-pipeline-engine-shared-helpers-red-fixtures] ok');
for (const name of cases) console.log(`- ${name}`);
