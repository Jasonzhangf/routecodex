import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const root = process.cwd();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-provider-response-host-split-'));

const baseFunctionMap = YAML.parse(fs.readFileSync(path.join(root, 'docs/architecture/function-map.yml'), 'utf8'));
const baseVerificationMap = YAML.parse(fs.readFileSync(path.join(root, 'docs/architecture/verification-map.yml'), 'utf8'));
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

function seedCleanFixture() {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  writeFile('src/modules/llmswitch/bridge/provider-response-native-calls.ts', 'export const nativeCalls = true;\n');
  writeFile('src/modules/llmswitch/bridge/provider-response-metadata-effects.ts', 'export const metadataEffects = true;\n');
  writeFile('src/modules/llmswitch/bridge/provider-response-effects.ts', 'export const responseEffects = true;\n');
  writeFile(
    'src/modules/llmswitch/bridge/provider-response-converter-host.ts',
    "import './provider-response-native-calls.js';\nimport './provider-response-metadata-effects.js';\nimport './provider-response-effects.js';\nexport async function convertProviderResponse() { return {}; }\n"
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
    ROUTECODEX_PROVIDER_RESPONSE_HOST_SPLIT_SCAN_ROOT: tmpRoot,
    ROUTECODEX_FUNCTION_MAP_PATH: writeYaml(`${name}/function-map.yml`, functionMap),
    ROUTECODEX_VERIFICATION_MAP_PATH: writeYaml(`${name}/verification-map.yml`, verificationMap),
    ROUTECODEX_PACKAGE_JSON_PATH: writeJson(`${name}/package.json`, packageJson),
  };

  const result = spawnSync(
    process.execPath,
    ['scripts/architecture/verify-provider-response-host-split.mjs'],
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
  runVerifier('local-native-helper-cluster', () => {
    writeFile(
      'src/modules/llmswitch/bridge/provider-response-converter-host.ts',
      "import './provider-response-native-calls.js';\nimport './provider-response-metadata-effects.js';\nimport './provider-response-effects.js';\nfunction executeHubPipelineWithNative() { return {}; }\nexport async function convertProviderResponse() { return executeHubPipelineWithNative(); }\n"
    );
  }, 'helper clusters must live in split modules'),

  runVerifier('missing-split-module', () => {
    fs.rmSync(path.join(tmpRoot, 'src/modules/llmswitch/bridge/provider-response-effects.ts'));
  }, 'required split module is missing'),

  runVerifier('missing-function-map-owner', ({ functionMap }) => {
    functionMap.owners = functionMap.owners.filter(
      (row) => row.feature_id !== 'hub.provider_response_host_split'
    );
  }, 'function-map missing feature_id'),

  runVerifier('missing-package-script', ({ packageJson }) => {
    delete packageJson.scripts['verify:provider-response-host-split'];
  }, 'package.json missing script'),

  runVerifier('revived-host-stage-result-branch', () => {
    writeFile(
      'src/modules/llmswitch/bridge/provider-response-converter-host.ts',
      "import './provider-response-native-calls.js';\nimport './provider-response-metadata-effects.js';\nimport './provider-response-effects.js';\nexport async function convertProviderResponse() { const respProcessEffect = { stage: 'HubRespChatProcess03Governed' }; return respProcessEffect.stage === 'HubRespChatProcess03Governed' ? {} : {}; }\n"
    );
  }, 'retired HubRespChatProcess03Governed host result branch must stay deleted'),

  runVerifier('revived-servertool-stage-result-union', () => {
    writeFile(
      'src/modules/llmswitch/bridge/provider-response-effects.ts',
      "export async function executeProviderResponseNativeServertoolEffects(): Promise<{ stage: 'HubRespChatProcess03Governed' | 'unchanged' }> { return { stage: 'unchanged' }; }\n"
    );
  }, 'retired servertool effect stage-result union must stay deleted'),

  runVerifier('revived-metadata-write-projection-wrapper', () => {
    writeFile(
      'src/modules/llmswitch/bridge/provider-response-metadata-effects.ts',
      "export function projectNativeMetadataWritePlanToRuntimeControlWritePlan() { return {}; }\n"
    );
  }, 'zero-caller metadata write projection wrapper must stay deleted'),

  runVerifier('revived-native-metadata-write-wrapper-fallback', () => {
    writeFile(
      'src/modules/llmswitch/bridge/provider-response-native-calls.ts',
      "export function projectMetadataWritePlanToRuntimeControlWritePlanWithNative() { const parsed = null; return typeof parsed === 'object' && parsed !== null ? parsed : {}; }\n"
    );
  }, 'zero-caller metadata write native wrapper and malformed-result fallback must stay deleted'),
];

console.log('[test:provider-response-host-split-red-fixtures] ok');
for (const name of cases) console.log(`- ${name}`);
