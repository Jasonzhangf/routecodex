import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

// feature_id: hub.servertool_core_shared_helpers

const root = process.cwd();
const scanRoot = process.env.ROUTECODEX_SERVERTOOL_CORE_HELPER_SCAN_ROOT
  ? path.resolve(root, process.env.ROUTECODEX_SERVERTOOL_CORE_HELPER_SCAN_ROOT)
  : root;
const functionMapPath =
  process.env.ROUTECODEX_FUNCTION_MAP_PATH ?? 'docs/architecture/function-map.yml';
const verificationMapPath =
  process.env.ROUTECODEX_VERIFICATION_MAP_PATH ?? 'docs/architecture/verification-map.yml';
const packageJsonPath = process.env.ROUTECODEX_PACKAGE_JSON_PATH ?? 'package.json';

const featureId = 'hub.servertool_core_shared_helpers';
const servertoolFile =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs';
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
    if (owner.owner_module !== sharedJsonFile) {
      failures.push(`function-map ${featureId}: owner_module must be ${sharedJsonFile}`);
    }
    for (const requiredPath of [
      servertoolFile,
      sharedJsonFile,
      'scripts/architecture/verify-servertool-core-shared-helpers.mjs',
      'scripts/tests/servertool-core-shared-helpers-red-fixtures.mjs',
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
    'verify:servertool-core-shared-helpers',
    'test:servertool-core-shared-helpers-red-fixtures',
    'test:servertool-core-shared-helpers-cargo',
  ]) {
    if (!Object.hasOwn(scripts, scriptName)) {
      failures.push(`package.json missing script: ${scriptName}`);
    }
  }

  const longtail = scripts['verify:architecture-ci-longtail'] ?? '';
  for (const gate of [
    'npm run test:servertool-core-shared-helpers-red-fixtures',
    'npm run verify:servertool-core-shared-helpers',
  ]) {
    if (!longtail.includes(gate)) {
      failures.push(`verify:architecture-ci-longtail missing ${gate}`);
    }
  }
}

function validateSource() {
  const files = new Map(listScanFiles().map((row) => [row.relPath, row]));
  for (const requiredFile of [servertoolFile, sharedJsonFile]) {
    if (!files.has(requiredFile)) {
      failures.push(`${requiredFile}: missing required source file`);
    }
  }
  if (failures.length > 0) return;

  const servertoolSource = fs.readFileSync(files.get(servertoolFile).absPath, 'utf8');
  const sharedJsonSource = fs.readFileSync(files.get(sharedJsonFile).absPath, 'utf8');

  for (const helper of ['parse_json_with_context', 'stringify_json_with_context']) {
    if (!new RegExp(`pub\\(crate\\)\\s+fn\\s+${helper}(?:\\s*<[^>]+>)?\\s*\\(`, 'u').test(sharedJsonSource)) {
      failures.push(`${sharedJsonFile}: missing shared ${helper} helper`);
    }
  }

  if (!servertoolSource.includes('use crate::shared_json_utils::{parse_json_with_context, stringify_json_with_context};')) {
    failures.push(`${servertoolFile}: must import contextual JSON helpers from shared_json_utils`);
  }

  const parseUses = (servertoolSource.match(/parse_json_with_context\(/gu) ?? []).length;
  const stringifyUses = (servertoolSource.match(/stringify_json_with_context\(/gu) ?? []).length;
  if (parseUses < 80) {
    failures.push(`${servertoolFile}: expected broad parse_json_with_context reuse, found ${parseUses}`);
  }
  if (stringifyUses < 50) {
    failures.push(`${servertoolFile}: expected broad stringify_json_with_context reuse, found ${stringifyUses}`);
  }

  const duplicateParseWrappers = (servertoolSource.match(/serde_json::from_str\([^)\n]+\)\s*\.map_err\(\|e\| format!\("[^"]+: \{e\}"\)\)\??/gu) ?? []).length;
  const duplicateStringifyWrappers = (servertoolSource.match(/serde_json::to_string\([^;\n]+\)\s*\.map_err\(\|e\| format!\("[^"]+: \{e\}"\)\)\??/gu) ?? []).length;
  if (duplicateParseWrappers > 35) {
    failures.push(`${servertoolFile}: too many local contextual parse wrappers remain (${duplicateParseWrappers})`);
  }
  if (duplicateStringifyWrappers > 20) {
    failures.push(`${servertoolFile}: too many local contextual stringify wrappers remain (${duplicateStringifyWrappers})`);
  }
}

validateMaps();
validateSource();

if (failures.length > 0) {
  console.error('[verify:servertool-core-shared-helpers] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:servertool-core-shared-helpers] ok');
console.log('- servertool_core_blocks shares contextual JSON parse/stringify bridge mechanics through shared_json_utils');
