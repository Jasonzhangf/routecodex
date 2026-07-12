import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const root = process.cwd();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-hub-native-reference-gate-'));

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
  writeFile('src/modules/llmswitch/bridge/routing-native-host.ts', "import { runNative } from './native-exports.js';\nexport { runNative };\n");
  writeFile('src/modules/llmswitch/bridge/native-exports.ts', 'export const runNative = () => undefined;\n');
  writeFile('tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts', "jest.unstable_mockModule('../../src/modules/llmswitch/bridge/routing-native-host.js', () => ({}));\n");
  writeFile('docs/architecture/wiki/hub-pipeline-rust-reference-closeout.md', '# Hub Pipeline Rust Reference Closeout\n\nOwner surface: Rust owner-specific narrow hosts; broad `native-exports.ts` is a private loader and forbidden legacy owner surface.\n');
}

function runVerifier(name, mutate, expectedSubstring) {
  seedCleanFixture();
  const functionMap = clone(baseFunctionMap);
  const verificationMap = clone(baseVerificationMap);
  const packageJson = clone(basePackageJson);
  mutate({ functionMap, verificationMap, packageJson });

  const env = {
    ...process.env,
    ROUTECODEX_HUB_PIPELINE_NATIVE_REFERENCE_SCAN_ROOT: tmpRoot,
    ROUTECODEX_FUNCTION_MAP_PATH: writeYaml(`${name}/function-map.yml`, functionMap),
    ROUTECODEX_VERIFICATION_MAP_PATH: writeYaml(`${name}/verification-map.yml`, verificationMap),
    ROUTECODEX_PACKAGE_JSON_PATH: writeJson(`${name}/package.json`, packageJson),
  };

  const result = spawnSync(
    process.execPath,
    ['scripts/architecture/verify-hub-pipeline-native-reference-gate.mjs'],
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
  runVerifier('runtime-broad-native-import', () => {
    writeFile('src/server/runtime/http-server/bad-runtime.ts', "import { runNative } from '../../../modules/llmswitch/bridge/native-exports.js';\nrunNative();\n");
  }, 'runtime source imports broad native-exports'),

  runVerifier('white-box-broad-native-mock', () => {
    writeFile('tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts', "import { createNativeExportsMock } from '../providers/helpers/llmswitch-native-exports-fake.js';\njest.unstable_mockModule('../../src/modules/llmswitch/bridge/native-exports.js', () => createNativeExportsMock());\n");
  }, 'monitored white-box test must mock owner-specific host'),

  runVerifier('handler-executor-broad-native-fake', () => {
    writeFile('tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts', "import { buildLlmswitchNativeExportsFake } from '../../providers/helpers/llmswitch-native-exports-fake.js';\nexport const fake = buildLlmswitchNativeExportsFake();\n");
  }, 'monitored white-box test must mock owner-specific host'),

  runVerifier('runtime-direct-native-helper-import', () => {
    writeFile('src/server/runtime/http-server/bad-direct-native.ts', "import { run } from '../../../../tests/sharedmodule/helpers/request-stage-direct-native.js';\nrun();\n");
  }, 'runtime source imports direct-native evidence helper'),

  runVerifier('stale-doc-owner-surface', () => {
    writeFile('docs/architecture/wiki/hub-pipeline-rust-reference-closeout.md', '# Hub Pipeline Rust Reference Closeout\n\nOwner surface: `src/modules/llmswitch/bridge/native-exports.ts` owns Hub Pipeline semantics.\n');
  }, 'doc/wiki owner surface names broad native-exports as owner'),

  runVerifier('missing-function-map-owner', ({ functionMap }) => {
    functionMap.owners = functionMap.owners.filter(
      (row) => row.feature_id !== 'hub.pipeline_rust_residual_reference_closeout'
    );
  }, 'function-map missing feature_id'),
];

console.log('[test:hub-pipeline-native-reference-gate-red-fixtures] ok');
for (const name of cases) console.log(`- ${name}`);
