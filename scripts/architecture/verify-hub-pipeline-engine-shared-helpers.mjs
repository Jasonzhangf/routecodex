import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

// feature_id: hub.pipeline_engine_shared_helpers

const root = process.cwd();
const scanRoot = process.env.ROUTECODEX_HUB_ENGINE_HELPER_SCAN_ROOT
  ? path.resolve(root, process.env.ROUTECODEX_HUB_ENGINE_HELPER_SCAN_ROOT)
  : root;
const functionMapPath =
  process.env.ROUTECODEX_FUNCTION_MAP_PATH ?? 'docs/architecture/function-map.yml';
const verificationMapPath =
  process.env.ROUTECODEX_VERIFICATION_MAP_PATH ?? 'docs/architecture/verification-map.yml';
const packageJsonPath = process.env.ROUTECODEX_PACKAGE_JSON_PATH ?? 'package.json';

const featureId = 'hub.pipeline_engine_shared_helpers';
const engineFile =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs';
const sharedJsonFile =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_json_utils.rs';

const failures = [];

function readText(filePath) {
  return fs.readFileSync(path.resolve(root, filePath), 'utf8');
}

function relFromScanRoot(absPath) {
  return path.relative(scanRoot, absPath).split(path.sep).join('/');
}

function isGeneratedOrExternal(relPath) {
  return /(^|\/)(dist|target|coverage|node_modules|\.git|\.mempalace|\.local-index)\//u.test(
    relPath,
  );
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
    failures.push(
      `git file discovery failed: ${tracked.stderr || others.stderr || tracked.stdout || others.stdout}`,
    );
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
    if (owner.owner_module !== sharedJsonFile) {
      failures.push(`function-map ${featureId}: owner_module must be ${sharedJsonFile}`);
    }
    for (const requiredPath of [
      engineFile,
      sharedJsonFile,
      'scripts/architecture/verify-hub-pipeline-engine-shared-helpers.mjs',
      'scripts/tests/hub-pipeline-engine-shared-helpers-red-fixtures.mjs',
    ]) {
      if (!Array.isArray(owner.allowed_paths) || !owner.allowed_paths.includes(requiredPath)) {
        failures.push(`function-map ${featureId}: missing allowed path ${requiredPath}`);
      }
    }
  }

  const verification = (verificationMap?.verification ?? []).find(
    (row) => row?.feature_id === featureId,
  );
  if (!verification) {
    failures.push(`verification-map missing feature_id: ${featureId}`);
  }

  for (const scriptName of [
    'verify:hub-pipeline-engine-shared-helpers',
    'test:hub-pipeline-engine-shared-helpers-red-fixtures',
    'test:hub-pipeline-engine-shared-helpers-cargo',
  ]) {
    if (!Object.hasOwn(scripts, scriptName)) {
      failures.push(`package.json missing script: ${scriptName}`);
    }
  }

  const longtail = scripts['verify:architecture-ci-longtail'] ?? '';
  for (const gate of [
    'npm run test:hub-pipeline-engine-shared-helpers-red-fixtures',
    'npm run verify:hub-pipeline-engine-shared-helpers',
  ]) {
    if (!longtail.includes(gate)) {
      failures.push(`verify:architecture-ci-longtail missing ${gate}`);
    }
  }
}

function validateSource() {
  const files = new Map(listScanFiles().map((row) => [row.relPath, row]));
  for (const requiredFile of [engineFile, sharedJsonFile]) {
    if (!files.has(requiredFile)) {
      failures.push(`${requiredFile}: missing required source file`);
    }
  }
  if (failures.length > 0) return;

  const engineSource = fs.readFileSync(files.get(engineFile).absPath, 'utf8');
  const sharedJsonSource = fs.readFileSync(files.get(sharedJsonFile).absPath, 'utf8');

  for (const helper of ['read_trimmed_string']) {
    if (!sharedJsonSource.includes(`fn ${helper}`)) {
      failures.push(`${sharedJsonFile}: missing shared ${helper} helper`);
    }
  }

  if (
    !engineSource.includes('use crate::shared_json_utils::read_trimmed_string;')
    && !engineSource.includes('read_trimmed_string,')
  ) {
    failures.push(`${engineFile}: must import shared trim helper from shared_json_utils`);
  }

  const trimmedUses = (engineSource.match(/read_trimmed_string\(/gu) ?? []).length;
  if (trimmedUses < 5) {
    failures.push(`${engineFile}: expected shared read_trimmed_string reuse, found ${trimmedUses}`);
  }

  if (!/let input:\s*ExecuteHubPipelineInput\s*=\s*serde_json::from_str\(&input_json\)\?/u.test(engineSource)) {
    failures.push(`${engineFile}: public execute_hub_pipeline_json must keep serde_json::from_str error-code behavior`);
  }

  const duplicateTrimHelpers = (engineSource.match(/\.and_then\(Value::as_str\)\s*[\s\S]{0,80}\.map\(str::trim\)\s*[\s\S]{0,120}\.filter\(\|value\|\s*!value\.is_empty\(\)\)\s*[\s\S]{0,80}\.map\(str::to_string\)/gu) ?? []).length;
  if (duplicateTrimHelpers > 12) {
    failures.push(`${engineFile}: too many local trimmed-string wrappers remain (${duplicateTrimHelpers})`);
  }

  if (/Rust stopless response hook (runtime|projection) returned invalid JSON[\s\S]{0,160}serde_json::from_str/u.test(engineSource)) {
    failures.push(`${engineFile}: stopless runtime/projection JSON parse must use parse_json_with_context`);
  }
}

validateMaps();
validateSource();

if (failures.length > 0) {
  console.error('[verify:hub-pipeline-engine-shared-helpers] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:hub-pipeline-engine-shared-helpers] ok');
console.log('- hub_pipeline_lib/engine.rs shares trimmed-string mechanics through shared_json_utils and has no local stopless JSON parse');
