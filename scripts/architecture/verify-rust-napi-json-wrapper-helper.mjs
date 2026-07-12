import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

// feature_id: hub.rust_napi_json_wrapper_helper

const root = process.cwd();
const scanRoot = process.env.ROUTECODEX_RUST_NAPI_JSON_SCAN_ROOT
  ? path.resolve(root, process.env.ROUTECODEX_RUST_NAPI_JSON_SCAN_ROOT)
  : root;
const functionMapPath =
  process.env.ROUTECODEX_FUNCTION_MAP_PATH ?? 'docs/architecture/function-map.yml';
const verificationMapPath =
  process.env.ROUTECODEX_VERIFICATION_MAP_PATH ?? 'docs/architecture/verification-map.yml';
const packageJsonPath = process.env.ROUTECODEX_PACKAGE_JSON_PATH ?? 'package.json';

const featureId = 'hub.rust_napi_json_wrapper_helper';
const helperFile = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/napi_json.rs';
const libFile = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs';
const failures = [];

function readText(filePath) {
  return fs.readFileSync(path.resolve(root, filePath), 'utf8');
}

function readScanText(relPath) {
  return fs.readFileSync(path.resolve(scanRoot, relPath), 'utf8');
}

function relFromScanRoot(absPath) {
  return path.relative(scanRoot, absPath).split(path.sep).join('/');
}

function isGeneratedOrExternal(relPath) {
  return /(^|\/)(dist|target|coverage|node_modules|\.git|\.mempalace|\.local-index)\//u.test(relPath);
}

function listScanFiles() {
  if (scanRoot !== root) {
    const out = [];
    const stack = [scanRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const abs = path.join(current, entry.name);
        const rel = relFromScanRoot(abs);
        if (entry.isDirectory()) {
          if (!isGeneratedOrExternal(`${rel}/`)) stack.push(abs);
          continue;
        }
        if (/\.(rs|json|yml|yaml)$/u.test(entry.name) && !isGeneratedOrExternal(rel)) {
          out.push({ relPath: rel, absPath: abs });
        }
      }
    }
    return out;
  }

  const tracked = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  const others = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (tracked.status !== 0 || others.status !== 0) {
    failures.push(`git file discovery failed: ${tracked.stderr || others.stderr || tracked.stdout || others.stdout}`);
    return [];
  }
  return `${tracked.stdout}\n${others.stdout}`
    .split('\n')
    .filter(Boolean)
    .filter((relPath, index, rows) => rows.indexOf(relPath) === index)
    .filter((relPath) => !isGeneratedOrExternal(relPath))
    .filter((relPath) => /\.(rs|json|yml|yaml)$/u.test(relPath))
    .map((relPath) => ({ relPath, absPath: path.join(root, relPath) }));
}

function validateMaps() {
  const functionMap = YAML.parse(readText(functionMapPath));
  const verificationMap = YAML.parse(readText(verificationMapPath));
  const packageJson = JSON.parse(readText(packageJsonPath));
  const scripts = packageJson.scripts ?? {};

  const owner = (functionMap?.owners ?? []).find((row) => row?.feature_id === featureId);
  if (!owner) {
    failures.push(`function-map missing feature_id: ${featureId}`);
  } else {
    if (owner.owner_module !== helperFile) {
      failures.push(`function-map ${featureId}: owner_module must be ${helperFile}`);
    }
    for (const builder of ['parse_napi_json', 'stringify_napi_json']) {
      if (!Array.isArray(owner.canonical_builders) || !owner.canonical_builders.includes(builder)) {
        failures.push(`function-map ${featureId}: missing canonical builder ${builder}`);
      }
    }
    for (const requiredPath of [helperFile, libFile]) {
      if (!Array.isArray(owner.allowed_paths) || !owner.allowed_paths.includes(requiredPath)) {
        failures.push(`function-map ${featureId}: missing allowed path ${requiredPath}`);
      }
    }
  }

  const verification = (verificationMap?.verification ?? []).find((row) => row?.feature_id === featureId);
  if (!verification) {
    failures.push(`verification-map missing feature_id: ${featureId}`);
  }

  for (const scriptName of [
    'verify:rust-napi-json-wrapper-helper',
    'test:rust-napi-json-wrapper-helper-red-fixtures',
  ]) {
    if (!Object.hasOwn(scripts, scriptName)) {
      failures.push(`package.json missing script: ${scriptName}`);
    }
  }

  const longtail = scripts['verify:architecture-ci-longtail'] ?? '';
  for (const gate of [
    'npm run test:rust-napi-json-wrapper-helper-red-fixtures',
    'npm run verify:rust-napi-json-wrapper-helper',
  ]) {
    if (!longtail.includes(gate)) {
      failures.push(`verify:architecture-ci-longtail missing ${gate}`);
    }
  }
}

function validateSource() {
  const files = new Map(listScanFiles().map((row) => [row.relPath, row]));
  if (!files.has(helperFile)) {
    failures.push(`${helperFile}: missing Rust NAPI JSON helper`);
    return;
  }
  if (!files.has(libFile)) {
    failures.push(`${libFile}: missing Rust NAPI entrypoint file`);
    return;
  }

  const helperSource = fs.readFileSync(files.get(helperFile).absPath, 'utf8');
  const libSource = fs.readFileSync(files.get(libFile).absPath, 'utf8');
  const parseHelperDefinitionMarker = ['pub(crate) fn ', 'parse_napi_json'].join('');
  const stringifyHelperDefinitionMarker = ['pub(crate) fn ', 'stringify_napi_json'].join('');
  for (const required of [
    parseHelperDefinitionMarker,
    stringifyHelperDefinitionMarker,
    'DeserializeOwned',
    'Serialize',
    'napi::Error::from_reason',
  ]) {
    if (!helperSource.includes(required)) {
      failures.push(`${helperFile}: missing helper marker ${required}`);
    }
  }
  if (!libSource.includes('mod napi_json;')) {
    failures.push(`${libFile}: missing mod napi_json declaration`);
  }
  if (!libSource.includes('use napi_json::{parse_napi_json, stringify_napi_json};')) {
    failures.push(`${libFile}: missing shared helper import`);
  }
  const parseUseCount = (libSource.match(/\bparse_napi_json\s*\(/gu) ?? []).length;
  const stringifyUseCount = (libSource.match(/\bstringify_napi_json\s*\(/gu) ?? []).length;
  if (parseUseCount < 10) {
    failures.push(`${libFile}: expected at least 10 parse_napi_json call sites, found ${parseUseCount}`);
  }
  if (stringifyUseCount < 10) {
    failures.push(`${libFile}: expected at least 10 stringify_napi_json call sites, found ${stringifyUseCount}`);
  }

  const monitoredFunctions = [
    'resolve_virtual_router_routing_state_key_json',
    'evaluate_singleton_route_pool_exhaustion_json',
    'resolve_error_err05_route_availability_decision_json',
    'analyze_pending_tool_sync_json',
    'analyze_chat_process_media_json',
    'parse_routing_instructions_json',
    'apply_routing_instructions_json',
  ];
  for (const name of monitoredFunctions) {
    const body = extractRustFunction(libSource, name);
    if (!body) {
      failures.push(`${libFile}: missing monitored NAPI wrapper ${name}`);
      continue;
    }
    if (!body.includes('parse_napi_json') && !body.includes('stringify_napi_json')) {
      failures.push(`${libFile}: ${name} must use napi_json helpers`);
    }
    if (/serde_json::(?:from_str|to_string)\s*\(/u.test(body)) {
      failures.push(`${libFile}: ${name} must not carry local serde_json parse/stringify wrappers`);
    }
  }
}

function extractRustFunction(source, name) {
  const start = source.indexOf(`pub fn ${name}(`);
  if (start < 0) return null;
  const braceStart = source.indexOf('{', start);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

validateMaps();
validateSource();

if (failures.length > 0) {
  console.error('[verify:rust-napi-json-wrapper-helper] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:rust-napi-json-wrapper-helper] ok');
console.log('- Rust NAPI JSON parse/stringify helper, usage, map bindings, package scripts, and longtail wiring checked');
