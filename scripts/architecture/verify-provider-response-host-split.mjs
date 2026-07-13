import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

// feature_id: hub.provider_response_host_split

const root = process.cwd();
const scanRoot = process.env.ROUTECODEX_PROVIDER_RESPONSE_HOST_SPLIT_SCAN_ROOT
  ? path.resolve(root, process.env.ROUTECODEX_PROVIDER_RESPONSE_HOST_SPLIT_SCAN_ROOT)
  : root;
const functionMapPath =
  process.env.ROUTECODEX_FUNCTION_MAP_PATH ?? 'docs/architecture/function-map.yml';
const verificationMapPath =
  process.env.ROUTECODEX_VERIFICATION_MAP_PATH ?? 'docs/architecture/verification-map.yml';
const packageJsonPath = process.env.ROUTECODEX_PACKAGE_JSON_PATH ?? 'package.json';

const featureId = 'hub.provider_response_host_split';
const hostFile = 'src/modules/llmswitch/bridge/provider-response-converter-host.ts';
const requiredModules = [
  'src/modules/llmswitch/bridge/provider-response-native-calls.ts',
  'src/modules/llmswitch/bridge/provider-response-metadata-effects.ts',
  'src/modules/llmswitch/bridge/provider-response-effects.ts',
];
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

  const result = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  });
  const tracked = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  if (tracked.status !== 0 || result.status !== 0) {
    failures.push(`git file discovery failed: ${tracked.stderr || result.stderr || tracked.stdout || result.stdout}`);
    return [];
  }
  return `${tracked.stdout}\n${result.stdout}`
    .split('\n')
    .filter(Boolean)
    .filter((relPath, index, rows) => rows.indexOf(relPath) === index)
    .filter((relPath) => !isGeneratedOrExternal(relPath))
    .filter((relPath) => /\.(ts|tsx|js|mjs|cjs|md|yml|yaml|json)$/u.test(relPath))
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
    if (owner.owner_module !== hostFile) {
      failures.push(`function-map ${featureId}: owner_module must be ${hostFile}`);
    }
    const allowedPaths = Array.isArray(owner.allowed_paths) ? owner.allowed_paths : [];
    for (const requiredPath of [hostFile, ...requiredModules]) {
      if (!allowedPaths.includes(requiredPath)) {
        failures.push(`function-map ${featureId}: missing allowed path ${requiredPath}`);
      }
    }
    const requiredGates = Array.isArray(owner.required_gates) ? owner.required_gates : [];
    for (const gate of [
      'npm run verify:provider-response-host-split',
      'npm run test:provider-response-host-split-red-fixtures',
    ]) {
      if (!requiredGates.includes(gate)) {
        failures.push(`function-map ${featureId}: missing required gate ${gate}`);
      }
    }
  }

  const verification = (verificationMap?.verification ?? []).find((row) => row?.feature_id === featureId);
  if (!verification) {
    failures.push(`verification-map missing feature_id: ${featureId}`);
  }

  for (const scriptName of [
    'verify:provider-response-host-split',
    'test:provider-response-host-split-red-fixtures',
  ]) {
    if (!Object.hasOwn(scripts, scriptName)) {
      failures.push(`package.json missing script: ${scriptName}`);
    }
  }

  const longtail = scripts['verify:architecture-ci-longtail'] ?? '';
  for (const gate of [
    'npm run test:provider-response-host-split-red-fixtures',
    'npm run verify:provider-response-host-split',
  ]) {
    if (!longtail.includes(gate)) {
      failures.push(`verify:architecture-ci-longtail missing ${gate}`);
    }
  }
}

function validateSourceSplit() {
  const files = new Map(listTrackedOrFixtureFiles().map((row) => [row.relPath, row]));
  const host = files.get(hostFile);
  if (!host) {
    failures.push(`${hostFile}: missing provider response host file`);
    return;
  }
  const hostSource = fs.readFileSync(host.absPath, 'utf8');
  for (const requiredModule of requiredModules) {
    if (!files.has(requiredModule)) {
      failures.push(`${requiredModule}: required split module is missing`);
    }
  }
  for (const importPath of [
    './provider-response-native-calls.js',
    './provider-response-metadata-effects.js',
    './provider-response-effects.js',
  ]) {
    if (!hostSource.includes(importPath)) {
      failures.push(`${hostFile}: missing split-module import ${importPath}`);
    }
  }
  if (hostSource.split('\n').length > 850) {
    failures.push(`${hostFile}: host file must stay under 850 lines after split`);
  }
  for (const pattern of [
    /\bfunction\s+(?:executeHubPipelineWithNative|buildProviderResponseMetadataSnapshotWithNative|materializeProviderResponseOutboundEffectPlanWithNative|resolveProviderProtocolWithNative|publishResponsesRecordPlanWithNative|buildProviderSseStreamReadErrorDescriptorWithNative|materializeProviderResponseSsePayloadWithNative|resolveProviderResponseContextHelpersWithNative|planChatProcessSessionUsageWithNative|buildSseFramesFromJsonWithNative)\s*\(/u,
    /\bfunction\s+(?:readBoundMetadataCenter|applyNativeRuntimeControlWritePlan|projectNativeMetadataWritePlanToRuntimeControlWritePlan|readMetadataCenterSnapshotForRust|writeRustStopGatewayContextToMetadataCenter)\s*\(/u,
    /\bfunction\s+(?:executeProviderResponseNativeOutboundEffects|executeProviderResponseNativeServertoolEffects|executeProviderResponseNativeRuntimeStateEffect|readProviderResponseNativeStreamPipe)\s*\(/u,
  ]) {
    if (pattern.test(hostSource)) {
      failures.push(`${hostFile}: native, metadata, and effect helper clusters must live in split modules`);
    }
  }
}

validateMaps();
validateSourceSplit();

if (failures.length > 0) {
  console.error('[verify:provider-response-host-split] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:provider-response-host-split] ok');
console.log('- provider response host split modules, map bindings, package scripts, and longtail wiring checked');
