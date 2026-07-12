import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const root = process.cwd();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-hub-bridge-native-json-invoker-'));

const baseFunctionMap = YAML.parse(fs.readFileSync(path.join(root, 'docs/architecture/function-map.yml'), 'utf8'));
const baseVerificationMap = YAML.parse(fs.readFileSync(path.join(root, 'docs/architecture/verification-map.yml'), 'utf8'));
const basePackageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function writeFile(relPath, content) {
  const absPath = path.join(tmpRoot, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf8');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
  writeFile('src/modules/llmswitch/bridge/native-json-invoker.ts', 'export function sharedNativeJsonInvokerFixture() { return {}; }\n');
  for (const relPath of [
    'src/modules/llmswitch/bridge/provider-response-native-calls.ts',
    'src/modules/llmswitch/bridge/provider-response-converter-host.ts',
    'src/modules/llmswitch/bridge/routing-integrations.ts',
    'src/modules/llmswitch/bridge/config-integrations.ts',
    'src/modules/llmswitch/bridge/snapshot-recorder.ts',
  ]) {
    writeFile(relPath, "import { parseNativeJsonResult } from './native-json-invoker.js';\nvoid parseNativeJsonResult;\n");
  }
}

function runVerifier(name, mutate, expectedSubstring) {
  seedCleanFixture();
  const functionMap = clone(baseFunctionMap);
  const verificationMap = clone(baseVerificationMap);
  const packageJson = clone(basePackageJson);
  mutate({ functionMap, verificationMap, packageJson });

  const env = {
    ...process.env,
    ROUTECODEX_HUB_BRIDGE_NATIVE_JSON_INVOKER_SCAN_ROOT: tmpRoot,
    ROUTECODEX_FUNCTION_MAP_PATH: writeYaml(`${name}/function-map.yml`, functionMap),
    ROUTECODEX_VERIFICATION_MAP_PATH: writeYaml(`${name}/verification-map.yml`, verificationMap),
    ROUTECODEX_PACKAGE_JSON_PATH: writeJson(`${name}/package.json`, packageJson),
  };

  const result = spawnSync(
    process.execPath,
    ['scripts/architecture/verify-hub-bridge-native-json-invoker-singleton.mjs'],
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
  runVerifier('duplicate-local-helper', () => {
    writeFile(
      'src/modules/llmswitch/bridge/routing-integrations.ts',
      "import { parseNativeJsonResult } from './native-json-invoker.js';\nfunction stringifyNativePayload(name, value) { return JSON.stringify(value); }\nvoid parseNativeJsonResult;\nvoid stringifyNativePayload;\n"
    );
  }, 'duplicate native JSON invoker helper must use'),

  runVerifier('missing-shared-import', () => {
    writeFile('src/modules/llmswitch/bridge/provider-response-native-calls.ts', 'export const nativeCalls = true;\n');
  }, 'monitored bridge file must use shared native-json-invoker'),

  runVerifier('config-local-json-mechanics', () => {
    writeFile(
      'src/modules/llmswitch/bridge/config-integrations.ts',
      "import { parseNativeJsonResult } from './native-json-invoker.js';\nconst raw = JSON.stringify({});\nconst parsed = JSON.parse(raw);\nvoid parseNativeJsonResult;\nvoid parsed;\n"
    );
  }, 'config native JSON call mechanics must use'),

  runVerifier('missing-function-map-owner', ({ functionMap }) => {
    functionMap.owners = functionMap.owners.filter(
      (row) => row.feature_id !== 'hub.bridge_native_json_invoker_singleton'
    );
  }, 'function-map missing feature_id'),

  runVerifier('missing-package-script', ({ packageJson }) => {
    delete packageJson.scripts['verify:hub-bridge-native-json-invoker-singleton'];
  }, 'package.json missing script'),
];

console.log('[test:hub-bridge-native-json-invoker-singleton-red-fixtures] ok');
for (const name of cases) console.log(`- ${name}`);
