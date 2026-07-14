import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-thin-wrapper-root-host-'));

const requiredRootHostFiles = [
  'src/server/runtime/http-server/executor-pipeline.ts',
  'src/server/runtime/http-server/request-executor.ts',
  'src/server/runtime/http-server/executor/provider-response-converter.ts',
  'src/server/runtime/http-server/executor/request-executor-provider-send-failure.ts',
  'src/server/runtime/http-server/executor/request-executor-provider-failure.ts',
  'src/server/handlers/responses-handler.ts',
  'src/modules/llmswitch/bridge/responses-request-bridge.ts',
  'src/modules/llmswitch/bridge/responses-conversation-store-host.ts',
];

function writeFile(relPath, content) {
  const absPath = path.join(tmpRoot, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf8');
}

function writeJson(relPath, value) {
  writeFile(relPath, `${JSON.stringify(value, null, 2)}\n`);
  return path.join(tmpRoot, relPath);
}

function cleanPackageJson() {
  return {
    scripts: {
      'verify:architecture-thin-wrapper-only': 'node scripts/architecture/verify-architecture-thin-wrapper-only.mjs',
      'test:architecture-thin-wrapper-only-red-fixtures': 'node scripts/tests/architecture-thin-wrapper-only-red-fixtures.mjs',
      'verify:architecture-ci-longtail': 'npm run test:architecture-thin-wrapper-only-red-fixtures',
    },
  };
}

function seedCleanFixture() {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  for (const relPath of requiredRootHostFiles) {
    writeFile(relPath, 'export const thinWrapperOnly = true;\n');
  }
  writeFile(
    'src/modules/llmswitch/bridge/provider-response-converter-host.ts',
    [
      "import { resolveProviderProtocolWithNative } from './provider-response-native-calls.js';",
      'export function convertProviderResponse(context) {',
      '  return resolveProviderProtocolWithNative({ metadataCenterSnapshot: context.metadataCenterSnapshot });',
      '}',
    ].join('\n')
  );
  writeFile(
    'src/modules/llmswitch/bridge/provider-response-effects.ts',
    [
      'export function executeProviderResponseNativeRuntimeStateEffect(args) {',
      '  return args.runtimeEffects;',
      '}',
    ].join('\n')
  );
  writeFile(
    'src/modules/llmswitch/bridge/provider-response-native-calls.ts',
    [
      'export function publishResponsesRecordPlanWithNative(args) {',
      '  return callNativeJsonCapability(binding, "publishResponsesRecordPlanJson", [args], { label: "fixture" });',
      '}',
    ].join('\n')
  );
  writeFile(
    'src/modules/llmswitch/bridge/native-exports.ts',
    'export const getRouterHotpathJsonBindingSync = () => ({});\n'
  );
}

function runVerifier(name, mutate, expectedSubstring) {
  seedCleanFixture();
  mutate();
  const packageJsonPath = writeJson(`${name}/package.json`, cleanPackageJson());
  const result = spawnSync(
    process.execPath,
    ['scripts/architecture/verify-architecture-thin-wrapper-only.mjs'],
    {
      cwd: root,
      env: {
        ...process.env,
        ROUTECODEX_ARCHITECTURE_THIN_WRAPPER_SCAN_ROOT: tmpRoot,
        ROUTECODEX_PACKAGE_JSON_PATH: packageJsonPath,
      },
      encoding: 'utf8',
    }
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

function runValidFixture() {
  seedCleanFixture();
  const packageJsonPath = writeJson('valid/package.json', cleanPackageJson());
  const result = spawnSync(
    process.execPath,
    ['scripts/architecture/verify-architecture-thin-wrapper-only.mjs'],
    {
      cwd: root,
      env: {
        ...process.env,
        ROUTECODEX_ARCHITECTURE_THIN_WRAPPER_SCAN_ROOT: tmpRoot,
        ROUTECODEX_PACKAGE_JSON_PATH: packageJsonPath,
      },
      encoding: 'utf8',
    }
  );
  if (result.status !== 0) {
    throw new Error(`valid fixture failed\n${result.stdout}\n${result.stderr}`);
  }
}

runValidFixture();

const cases = [
  runVerifier(
    'checked-files-zero',
    () => {
      fs.rmSync(path.join(tmpRoot, 'src'), { recursive: true, force: true });
    },
    'root host checked files: 0'
  ),
  runVerifier(
    'handler-save-revival',
    () => {
      writeFile(
        'src/server/handlers/responses-handler.ts',
        'export async function handleResponses(result) { await finalizeResponsesPipelineResultForHttp(result); }\n'
      );
    },
    'handler/request bridge must not own response-side relay continuation save'
  ),
  runVerifier(
    'store-writer-revival',
    () => {
      writeFile(
        'src/modules/llmswitch/bridge/responses-request-bridge.ts',
        'export function bridge(result) { return seedResponsesToolCallResponseForHttp(result); }\n'
      );
    },
    'handler/request bridge must not own response-side relay continuation save'
  ),
  runVerifier(
    'errorerr-ts-classifier-revival',
    () => {
      writeFile(
        'src/server/runtime/http-server/executor/provider-response-converter.ts',
        [
          'export function classify(error) {',
          '  const message = error.message.toLowerCase();',
          '  const statusCode = message.includes("rate limit") ? 429 : 500;',
          '  const retryable = statusCode >= 500;',
          '  return { statusCode, retryable };',
          '}',
        ].join('\n')
      );
    },
    'provider response host must not own ErrorErr retry/status/message classification'
  ),
  runVerifier(
    'flat-provider-protocol-fallback-revival',
    () => {
      writeFile(
        'src/server/runtime/http-server/executor/provider-response-converter.ts',
        'export function read(metadata) { const providerProtocol = metadata?.providerProtocol ?? "openai-chat"; return providerProtocol; }\n'
      );
    },
    'root host must not rebuild providerProtocol from flat metadata'
  ),
  runVerifier(
    'flat-excluded-provider-keys-revival',
    () => {
      writeFile(
        'src/server/runtime/http-server/executor-pipeline.ts',
        'export function run(metadata) { return metadata.excludedProviderKeys || []; }\n'
      );
    },
    'root host must not restore retry exclusion truth from flat metadata'
  ),
  runVerifier(
    'semantic-output-fallback-revival',
    () => {
      writeFile(
        'src/modules/llmswitch/bridge/provider-response-effects.ts',
        'export function output(runtimeOutput, originalPayload) { return runtimeOutput.chatResponse ?? originalPayload; }\n'
      );
    },
    'provider response host must not fallback to runtime output or original payload semantics'
  ),
  runVerifier(
    'malformed-plan-downgrade-revival',
    () => {
      writeFile(
        'src/modules/llmswitch/bridge/provider-response-native-calls.ts',
        'export function run(plan) { try { return native(plan); } catch (error) { return {}; } }\n'
      );
    },
    'malformed native/Rust plan must fail fast'
  ),
  runVerifier(
    'broad-native-facade-revival',
    () => {
      writeFile(
        'src/server/runtime/http-server/executor/provider-response-converter.ts',
        "import { executeHubPipelineJson } from '../../../../modules/llmswitch/bridge/native-exports.js';\nexport const run = executeHubPipelineJson;\n"
      );
    },
    'root host runtime must not import broad native-exports'
  ),
  runVerifier(
    'dead-wrapper-revival',
    () => {
      writeFile(
        'src/modules/llmswitch/bridge/provider-response-converter-host.ts',
        'export function run(plan) { return projectNativeMetadataWritePlanToRuntimeControlWritePlan(plan); }\n'
      );
    },
    'deleted provider-response metadata wrapper/fallback surface must not revive'
  ),
];

console.log('[test:architecture-thin-wrapper-only-red-fixtures] ok');
for (const name of cases) console.log(`- ${name}`);
