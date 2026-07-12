import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const root = process.cwd();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-vr-shared-helper-'));

const baseFunctionMap = YAML.parse(fs.readFileSync(path.join(root, 'docs/architecture/function-map.yml'), 'utf8'));
const baseVerificationMap = YAML.parse(fs.readFileSync(path.join(root, 'docs/architecture/verification-map.yml'), 'utf8'));
const basePackageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const utilsFile =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/utils.rs';
const routingModFile =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/mod.rs';
const bootstrapFile =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/bootstrap.rs';
const providerBootstrapFile =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/provider_bootstrap.rs';
const availabilityFile =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/error_err05_availability.rs';
const metadataFile =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/metadata.rs';
const toolsFile =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/features/tools.rs';
const trimHelper = ['trim_nonempty', 'str'].join('_');
const pushHelper = ['push_unique', 'trimmed'].join('_');
const normalizeUniqueHelper = ['normalize_unique', 'trimmed_strings'].join('_');
const normalizeValuesHelper = ['normalize_trimmed', 'string_values'].join('_');

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

function seedCleanFixture() {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  writeFile(utilsFile, `
use serde_json::Value;
use std::collections::HashSet;

pub(crate) fn ${trimHelper}(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
}

pub(crate) fn ${pushHelper}(out: &mut Vec<String>, seen: &mut HashSet<String>, value: &str) {
    if let Some(normalized) = ${trimHelper}(value) {
        if seen.insert(normalized.clone()) { out.push(normalized); }
    }
}

pub(crate) fn ${normalizeUniqueHelper}<'a, I>(values: I) -> Vec<String>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for value in values { ${pushHelper}(&mut out, &mut seen, value); }
    out
}

pub(crate) fn ${normalizeValuesHelper}<'a, I>(values: I) -> Vec<String>
where
    I: IntoIterator<Item = &'a Value>,
{
    values.into_iter().filter_map(|value| value.as_str().and_then(${trimHelper})).collect()
}
`);
  writeFile(routingModFile, `
pub(crate) use utils::{
    normalize_trimmed_string_values, normalize_unique_trimmed_strings, push_unique_trimmed,
    trim_nonempty_str,
};
`);
  writeFile(bootstrapFile, `
use crate::virtual_router_engine::routing::utils::{push_unique_trimmed, trim_nonempty_str};
fn demo(out: &mut Vec<String>, seen: &mut std::collections::HashSet<String>, value: &str) {
    let _ = trim_nonempty_str(value);
    push_unique_trimmed(out, seen, value);
}
`);
  writeFile(providerBootstrapFile, `
use crate::virtual_router_engine::routing::utils::push_unique_trimmed;
fn demo(out: &mut Vec<String>, seen: &mut std::collections::HashSet<String>, value: &str) {
    push_unique_trimmed(out, seen, value);
}
`);
  writeFile(availabilityFile, `
use crate::virtual_router_engine::routing::utils::{normalize_unique_trimmed_strings, trim_nonempty_str};
fn demo(values: &[String]) -> Vec<String> {
    let _ = trim_nonempty_str("x");
    normalize_unique_trimmed_strings(values.iter().map(String::as_str))
}
`);
  writeFile(metadataFile, `
use crate::virtual_router_engine::routing::utils::normalize_trimmed_string_values;
fn demo(values: &[serde_json::Value]) -> Vec<String> {
    normalize_trimmed_string_values(values.iter())
}
`);
  writeFile(toolsFile, `
const WRITE_TOOL_EXACT: &[&str] = &["edit"];
const WRITE_TOOL_KEYWORDS: &[&str] = &["write"];
const WEB_TOOL_KEYWORDS: &[&str] = &["web_search"];
fn demo(name: &str) -> bool {
    WRITE_TOOL_EXACT.contains(&name) || WRITE_TOOL_KEYWORDS.iter().any(|item| name.contains(item)) || WEB_TOOL_KEYWORDS.contains(&name)
}
`);
}

function runVerifier(name, mutate, expectedSubstring) {
  seedCleanFixture();
  const functionMap = clone(baseFunctionMap);
  const verificationMap = clone(baseVerificationMap);
  const packageJson = clone(basePackageJson);
  mutate({ functionMap, verificationMap, packageJson });

  const env = {
    ...process.env,
    ROUTECODEX_VR_SHARED_HELPER_SCAN_ROOT: tmpRoot,
    ROUTECODEX_FUNCTION_MAP_PATH: writeYaml(`${name}/function-map.yml`, functionMap),
    ROUTECODEX_VERIFICATION_MAP_PATH: writeYaml(`${name}/verification-map.yml`, verificationMap),
    ROUTECODEX_PACKAGE_JSON_PATH: writeJson(`${name}/package.json`, packageJson),
  };
  const result = spawnSync(
    process.execPath,
    ['scripts/architecture/verify-vr-shared-function-library-helpers.mjs'],
    { cwd: root, env, encoding: 'utf8' }
  );
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0) throw new Error(`${name}: expected verifier failure, got success\n${output}`);
  if (!output.includes(expectedSubstring)) {
    throw new Error(`${name}: expected ${JSON.stringify(expectedSubstring)}\n${output}`);
  }
  return name;
}

const cases = [
  runVerifier('bootstrap-local-helper-reintroduced', () => {
    writeFile(bootstrapFile, `${fs.readFileSync(path.join(tmpRoot, bootstrapFile), 'utf8')}\nfn read_non_empty_string(_: Option<&serde_json::Value>) -> Option<String> { None }\n`);
  }, 'local duplicate helper read_non_empty_string'),

  runVerifier('availability-local-helper-reintroduced', () => {
    writeFile(availabilityFile, `${fs.readFileSync(path.join(tmpRoot, availabilityFile), 'utf8')}\nfn normalize_string_list(_: &[String]) -> Vec<String> { Vec::new() }\n`);
  }, 'local duplicate helper normalize_string_list'),

  runVerifier('tool-local-array-reintroduced', () => {
    writeFile(toolsFile, `${fs.readFileSync(path.join(tmpRoot, toolsFile), 'utf8')}\nfn bad() { let write_keywords = [\"write\"]; let _ = write_keywords; }\n`);
  }, 'reintroduced local duplicate array let write_keywords = ['),

  runVerifier('missing-shared-helper', () => {
    const marker = ['pub(crate) fn push_unique', 'trimmed'].join('_');
    writeFile(utilsFile, fs.readFileSync(path.join(tmpRoot, utilsFile), 'utf8').replace(marker, 'fn push_unique_trimmed_removed'));
  }, 'missing shared helper push_unique_trimmed'),

  runVerifier('missing-function-map-owner', ({ functionMap }) => {
    functionMap.owners = functionMap.owners.filter((row) => row.feature_id !== 'vr.shared_function_library_helpers');
  }, 'function-map missing feature_id'),

  runVerifier('missing-package-script', ({ packageJson }) => {
    delete packageJson.scripts['verify:vr-shared-function-library-helpers'];
  }, 'package.json missing script'),
];

console.log('[test:vr-shared-function-library-helpers-red-fixtures] ok');
for (const name of cases) console.log(`- ${name}`);
