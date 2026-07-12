import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

// feature_id: hub.reasoning_tool_normalizer_shared_helpers

const root = process.cwd();
const scanRoot = process.env.ROUTECODEX_REASONING_HELPER_SCAN_ROOT
  ? path.resolve(root, process.env.ROUTECODEX_REASONING_HELPER_SCAN_ROOT)
  : root;
const functionMapPath =
  process.env.ROUTECODEX_FUNCTION_MAP_PATH ?? 'docs/architecture/function-map.yml';
const verificationMapPath =
  process.env.ROUTECODEX_VERIFICATION_MAP_PATH ?? 'docs/architecture/verification-map.yml';
const packageJsonPath = process.env.ROUTECODEX_PACKAGE_JSON_PATH ?? 'package.json';

const featureId = 'hub.reasoning_tool_normalizer_shared_helpers';
const reasoningFile =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_reasoning_tool_normalizer.rs';
const sharedJsonFile =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_json_utils.rs';
const sharedToolingFile =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_tooling.rs';
const sharedToolCallIdFile =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_tool_call_id_core.rs';
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
    if (owner.owner_module !== reasoningFile) {
      failures.push(`function-map ${featureId}: owner_module must be ${reasoningFile}`);
    }
    for (const requiredPath of [
      reasoningFile,
      sharedJsonFile,
      sharedToolingFile,
      sharedToolCallIdFile,
    ]) {
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
    'verify:hub-reasoning-tool-normalizer-shared-helpers',
    'test:hub-reasoning-tool-normalizer-shared-helpers-red-fixtures',
  ]) {
    if (!Object.hasOwn(scripts, scriptName)) {
      failures.push(`package.json missing script: ${scriptName}`);
    }
  }

  const longtail = scripts['verify:architecture-ci-longtail'] ?? '';
  for (const gate of [
    'npm run test:hub-reasoning-tool-normalizer-shared-helpers-red-fixtures',
    'npm run verify:hub-reasoning-tool-normalizer-shared-helpers',
  ]) {
    if (!longtail.includes(gate)) {
      failures.push(`verify:architecture-ci-longtail missing ${gate}`);
    }
  }
}

function validateSource() {
  const files = new Map(listScanFiles().map((row) => [row.relPath, row]));
  for (const requiredFile of [reasoningFile, sharedJsonFile, sharedToolingFile, sharedToolCallIdFile]) {
    if (!files.has(requiredFile)) {
      failures.push(`${requiredFile}: missing required source file`);
    }
  }
  if (failures.length > 0) return;

  const reasoningSource = fs.readFileSync(files.get(reasoningFile).absPath, 'utf8');
  for (const required of [
    'extract_balanced_json_object_at',
    'clamp_responses_input_item_id',
    'is_image_path',
  ]) {
    if (!reasoningSource.includes(required)) {
      failures.push(`${reasoningFile}: missing shared helper usage marker ${required}`);
    }
  }
  for (const helperName of [
    'is_image_path',
    'clamp_responses_input_item_id',
    'extract_balanced_json_object_at',
    'extract_balanced_json_array_at',
  ]) {
    if (new RegExp(`^fn\\s+${helperName}\\s*\\(`, 'mu').test(reasoningSource)) {
      failures.push(`${reasoningFile}: reintroduced local duplicate helper fn ${helperName}`);
    }
  }
}

validateMaps();
validateSource();

if (failures.length > 0) {
  console.error('[verify:hub-reasoning-tool-normalizer-shared-helpers] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:hub-reasoning-tool-normalizer-shared-helpers] ok');
console.log('- reasoning tool normalizer uses shared Rust helpers for image path, Responses item id clamp, and balanced JSON object extraction');
