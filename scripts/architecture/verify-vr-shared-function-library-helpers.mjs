import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

// feature_id: vr.shared_function_library_helpers

const root = process.cwd();
const scanRoot = process.env.ROUTECODEX_VR_SHARED_HELPER_SCAN_ROOT
  ? path.resolve(root, process.env.ROUTECODEX_VR_SHARED_HELPER_SCAN_ROOT)
  : root;
const functionMapPath =
  process.env.ROUTECODEX_FUNCTION_MAP_PATH ?? 'docs/architecture/function-map.yml';
const verificationMapPath =
  process.env.ROUTECODEX_VERIFICATION_MAP_PATH ?? 'docs/architecture/verification-map.yml';
const packageJsonPath = process.env.ROUTECODEX_PACKAGE_JSON_PATH ?? 'package.json';

const featureId = 'vr.shared_function_library_helpers';
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

const failures = [];

function readText(filePath) {
  return fs.readFileSync(path.resolve(root, filePath), 'utf8');
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
    if (owner.owner_module !== 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine') {
      failures.push(`${featureId}: owner_module must be virtual_router_engine`);
    }
    for (const requiredPath of [
      utilsFile,
      routingModFile,
      bootstrapFile,
      providerBootstrapFile,
      availabilityFile,
      metadataFile,
      toolsFile,
    ]) {
      if (!Array.isArray(owner.allowed_paths) || !owner.allowed_paths.includes(requiredPath)) {
        failures.push(`${featureId}: missing allowed path ${requiredPath}`);
      }
    }
  }

  const verification = (verificationMap?.verification ?? []).find((row) => row?.feature_id === featureId);
  if (!verification) {
    failures.push(`verification-map missing feature_id: ${featureId}`);
  }

  for (const scriptName of [
    'verify:vr-shared-function-library-helpers',
    'test:vr-shared-function-library-helpers-red-fixtures',
    'test:vr-shared-function-library-helpers-cargo',
  ]) {
    if (!Object.hasOwn(scripts, scriptName)) {
      failures.push(`package.json missing script: ${scriptName}`);
    }
  }

  const longtail = scripts['verify:architecture-ci-longtail'] ?? '';
  for (const gate of [
    'npm run test:vr-shared-function-library-helpers-red-fixtures',
    'npm run verify:vr-shared-function-library-helpers',
  ]) {
    if (!longtail.includes(gate)) {
      failures.push(`verify:architecture-ci-longtail missing ${gate}`);
    }
  }
}

function functionDefined(source, name) {
  return new RegExp(`^\\s*(?:pub\\(crate\\)\\s+)?fn\\s+${name}(?:\\s*<[^>]+>)?\\s*\\(`, 'mu').test(source);
}

function validateSource() {
  const files = new Map(listScanFiles().map((row) => [row.relPath, row]));
  for (const requiredFile of [utilsFile, routingModFile, bootstrapFile, providerBootstrapFile, availabilityFile, metadataFile, toolsFile]) {
    if (!files.has(requiredFile)) failures.push(`${requiredFile}: missing required source file`);
  }
  if (failures.length > 0) return;

  const source = Object.fromEntries(
    [utilsFile, routingModFile, bootstrapFile, providerBootstrapFile, availabilityFile, metadataFile, toolsFile].map((file) => [
      file,
      fs.readFileSync(files.get(file).absPath, 'utf8'),
    ])
  );

  for (const helperName of [
    'trim_nonempty_str',
    'push_unique_trimmed',
    'normalize_unique_trimmed_strings',
    'normalize_trimmed_string_values',
  ]) {
    if (!functionDefined(source[utilsFile], helperName)) {
      failures.push(`${utilsFile}: missing shared helper ${helperName}`);
    }
  }

  for (const token of ['trim_nonempty_str', 'push_unique_trimmed', 'normalize_unique_trimmed_strings', 'normalize_trimmed_string_values']) {
    if (!source[routingModFile].includes(token)) failures.push(`${routingModFile}: must re-export shared helper ${token}`);
  }

  for (const [filePath, names] of [
    [bootstrapFile, ['read_non_empty_string', 'push_unique']],
    [providerBootstrapFile, ['push_unique_string']],
    [availabilityFile, ['normalize_string_list', 'trim_nonempty']],
  ]) {
    for (const name of names) {
      if (functionDefined(source[filePath], name)) {
        failures.push(`${filePath}: local duplicate helper ${name} must use routing::utils shared helper`);
      }
    }
  }

  for (const [filePath, required] of [
    [bootstrapFile, ['trim_nonempty_str', 'push_unique_trimmed']],
    [providerBootstrapFile, ['push_unique_trimmed']],
    [availabilityFile, ['normalize_unique_trimmed_strings', 'trim_nonempty_str']],
    [metadataFile, ['normalize_trimmed_string_values']],
  ]) {
    for (const token of required) {
      if (!source[filePath].includes(token)) failures.push(`${filePath}: must use shared helper ${token}`);
    }
  }

  for (const localArray of ['let write_keywords = [', 'let write_exact = [', 'let web_tool_keywords = [']) {
    if (source[toolsFile].includes(localArray)) {
      failures.push(`${toolsFile}: reintroduced local duplicate array ${localArray}`);
    }
  }
  for (const token of ['WRITE_TOOL_EXACT', 'WRITE_TOOL_KEYWORDS', 'WEB_TOOL_KEYWORDS']) {
    if (!source[toolsFile].includes(token)) failures.push(`${toolsFile}: must use shared constant ${token}`);
  }
}

validateMaps();
validateSource();

if (failures.length > 0) {
  console.error('[verify:vr-shared-function-library-helpers] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:vr-shared-function-library-helpers] ok');
console.log('- VR string/list helper clones and tool-detection local arrays are blocked');
