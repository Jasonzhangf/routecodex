import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

// feature_id: hub.bridge_native_json_invoker_singleton
// Gate owner: verifyHubBridgeNativeJsonInvokerSingleton

const root = process.cwd();
const scanRoot = process.env.ROUTECODEX_HUB_BRIDGE_NATIVE_JSON_INVOKER_SCAN_ROOT
  ? path.resolve(root, process.env.ROUTECODEX_HUB_BRIDGE_NATIVE_JSON_INVOKER_SCAN_ROOT)
  : root;
const functionMapPath =
  process.env.ROUTECODEX_FUNCTION_MAP_PATH ?? 'docs/architecture/function-map.yml';
const verificationMapPath =
  process.env.ROUTECODEX_VERIFICATION_MAP_PATH ?? 'docs/architecture/verification-map.yml';
const packageJsonPath = process.env.ROUTECODEX_PACKAGE_JSON_PATH ?? 'package.json';

const featureId = 'hub.bridge_native_json_invoker_singleton';
const failures = [];

const ownerFile = 'src/modules/llmswitch/bridge/native-json-invoker.ts';
const monitoredBridgeFiles = new Set([
  'src/modules/llmswitch/bridge/provider-response-native-calls.ts',
  'src/modules/llmswitch/bridge/provider-response-converter-host.ts',
  'src/modules/llmswitch/bridge/routing-integrations.ts',
  'src/modules/llmswitch/bridge/config-integrations.ts',
  'src/modules/llmswitch/bridge/snapshot-recorder.ts',
]);

const nativeInvokerConsumerFiles = new Set([
  'src/modules/llmswitch/bridge/provider-response-native-calls.ts',
  'src/modules/llmswitch/bridge/routing-integrations.ts',
  'src/modules/llmswitch/bridge/config-integrations.ts',
  'src/modules/llmswitch/bridge/snapshot-recorder.ts',
]);

const forbiddenHelperDefinitions = [
  /\bfunction\s+loadNativeConfigBinding\s*\(/u,
  /\bfunction\s+parseNativeConfigJsonResult\s*\(/u,
  /\bfunction\s+requireNativeBindingFunction\s*\(/u,
  /\bfunction\s+callNativeJsonObject\s*\(/u,
  /\bfunction\s+parseNativeJsonResult\s*\(/u,
  /\bfunction\s+parseHubPipelineNativeJsonResult\s*\(/u,
  /\bfunction\s+callSnapshotNativeJson\s*\(/u,
  /\bfunction\s+stringifySnapshotNativeArg\s*\(/u,
  /\bfunction\s+stringifyNativePayload\s*\(/u,
  /\bfunction\s+parseNativeRecord\s*\(/u,
  /\bfunction\s+requireProviderResponseNativeJsonFunction\s*\(/u,
  /\bconst\s+(?:requireNativeBindingFunction|callNativeJsonObject|parseNativeJsonResult|parseHubPipelineNativeJsonResult|callSnapshotNativeJson|stringifySnapshotNativeArg|stringifyNativePayload|parseNativeRecord|requireProviderResponseNativeJsonFunction)\b/u,
];

const configLocalJsonMechanics = [
  /\bJSON\.parse\s*\(/u,
  /\bJSON\.stringify\s*\(/u,
  /\bconst\s+binding\s*=/u,
  /\bconst\s+fn\s*=/u,
  /\btypeof\s+fn\s*!==\s*['"]function['"]/u,
];

function readText(filePath) {
  return fs.readFileSync(path.resolve(root, filePath), 'utf8');
}

function relFromScanRoot(absPath) {
  return path.relative(scanRoot, absPath).split(path.sep).join('/');
}

function isGeneratedOrExternal(relPath) {
  return /(^|\/)(dist|target|coverage|node_modules|\.git|\.mempalace|\.local-index)\//u.test(relPath);
}

function listTrackedOrFixtureFiles() {
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
        if (/\.(ts|tsx|js|mjs|cjs|md|yml|yaml|json)$/u.test(entry.name) && !isGeneratedOrExternal(rel)) {
          out.push({ relPath: rel, absPath: abs });
        }
      }
    }
    return out;
  }

  const result = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    failures.push(`git ls-files failed: ${result.stderr || result.stdout}`);
    return [];
  }
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .filter((relPath) => !isGeneratedOrExternal(relPath))
    .filter((relPath) => /\.(ts|tsx|js|mjs|cjs|md|yml|yaml|json)$/u.test(relPath))
    .map((relPath) => ({ relPath, absPath: path.join(root, relPath) }));
}

function validateMaps() {
  const functionMap = YAML.parse(readText(functionMapPath));
  const verificationMap = YAML.parse(readText(verificationMapPath));
  const packageJson = JSON.parse(readText(packageJsonPath));
  const packageScripts = packageJson.scripts ?? {};

  const owner = (functionMap?.owners ?? []).find((row) => row?.feature_id === featureId);
  if (!owner) {
    failures.push(`function-map missing feature_id: ${featureId}`);
  } else {
    if (owner.owner_module !== ownerFile) {
      failures.push(`function-map ${featureId}: owner_module must be ${ownerFile}`);
    }
    const allowedPaths = Array.isArray(owner.allowed_paths) ? owner.allowed_paths : [];
    for (const requiredPath of [ownerFile, ...monitoredBridgeFiles]) {
      if (!allowedPaths.includes(requiredPath)) {
        failures.push(`function-map ${featureId}: missing allowed path ${requiredPath}`);
      }
    }
    const requiredGates = Array.isArray(owner.required_gates) ? owner.required_gates : [];
    for (const gate of [
      'npm run verify:hub-bridge-native-json-invoker-singleton',
      'npm run test:hub-bridge-native-json-invoker-singleton-red-fixtures',
    ]) {
      if (!requiredGates.includes(gate)) {
        failures.push(`function-map ${featureId}: missing required gate ${gate}`);
      }
    }
  }

  const verification = (verificationMap?.verification ?? []).find(
    (row) => row?.feature_id === featureId
  );
  if (!verification) {
    failures.push(`verification-map missing feature_id: ${featureId}`);
  }

  for (const scriptName of [
    'verify:hub-bridge-native-json-invoker-singleton',
    'test:hub-bridge-native-json-invoker-singleton-red-fixtures',
  ]) {
    if (!Object.hasOwn(packageScripts, scriptName)) {
      failures.push(`package.json missing script: ${scriptName}`);
    }
  }
  const longtail = packageScripts['verify:architecture-ci-longtail'] ?? '';
  for (const scriptName of [
    'npm run test:hub-bridge-native-json-invoker-singleton-red-fixtures',
    'npm run verify:hub-bridge-native-json-invoker-singleton',
  ]) {
    if (!longtail.includes(scriptName)) {
      failures.push(`verify:architecture-ci-longtail missing ${scriptName}`);
    }
  }
}

function verifyHubBridgeNativeJsonInvokerSingleton() {
  validateMaps();

  for (const { relPath, absPath } of listTrackedOrFixtureFiles()) {
    if (!monitoredBridgeFiles.has(relPath)) continue;
    const source = fs.readFileSync(absPath, 'utf8');
    for (const pattern of forbiddenHelperDefinitions) {
      if (pattern.test(source)) {
        failures.push(`${relPath}: duplicate native JSON invoker helper must use ${ownerFile}`);
      }
    }
    if (relPath === 'src/modules/llmswitch/bridge/config-integrations.ts') {
      for (const pattern of configLocalJsonMechanics) {
        if (pattern.test(source)) {
          failures.push(`${relPath}: config native JSON call mechanics must use ${ownerFile}`);
        }
      }
    }
    if (nativeInvokerConsumerFiles.has(relPath) && !source.includes("from './native-json-invoker.js'")) {
      failures.push(`${relPath}: monitored bridge file must use shared native-json-invoker`);
    }
  }
}

verifyHubBridgeNativeJsonInvokerSingleton();

if (failures.length > 0) {
  console.error('[verify:hub-bridge-native-json-invoker-singleton] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:hub-bridge-native-json-invoker-singleton] ok');
console.log('- duplicate local native JSON invokers, map bindings, package scripts, and longtail wiring checked');
