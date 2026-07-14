import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

// feature_id: hub.pipeline_rust_residual_reference_closeout
// Gate owner: verifyHubPipelineNativeReferenceGate

const root = process.cwd();
const scanRoot = process.env.ROUTECODEX_HUB_PIPELINE_NATIVE_REFERENCE_SCAN_ROOT
  ? path.resolve(root, process.env.ROUTECODEX_HUB_PIPELINE_NATIVE_REFERENCE_SCAN_ROOT)
  : root;
const functionMapPath =
  process.env.ROUTECODEX_FUNCTION_MAP_PATH ?? 'docs/architecture/function-map.yml';
const verificationMapPath =
  process.env.ROUTECODEX_VERIFICATION_MAP_PATH ?? 'docs/architecture/verification-map.yml';
const packageJsonPath = process.env.ROUTECODEX_PACKAGE_JSON_PATH ?? 'package.json';

const closeoutFeatureId = 'hub.pipeline_rust_residual_reference_closeout';
const failures = [];

const allowedRuntimeBroadImportFiles = new Set([
  'src/modules/llmswitch/bridge/native-exports.ts',
]);

const allowedNativeLoaderBridgePrefix = 'src/modules/llmswitch/bridge/';

const monitoredWhiteBoxTests = [
  'tests/modules/llmswitch/bridge/responses-request-bridge.metadata-center.spec.ts',
  'tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts',
  'tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts',
  'tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts',
  'tests/sharedmodule/provider-response-rust-plan.spec.ts',
  'tests/sharedmodule/provider-response.metadata-center-provider-protocol.spec.ts',
  'tests/server/runtime/http-server/request-executor.metadata-center.contract.spec.ts',
  'tests/server/handlers/handler-request-executor.unified-semantics.e2e.spec.ts',
  'tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts',
];

const monitoredBroadFakeHelperTests = new Set([
  'tests/server/handlers/handler-request-executor.unified-semantics.e2e.spec.ts',
  'tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts',
  'tests/server/runtime/http-server/request-executor.metadata-center.contract.spec.ts',
]);

function readText(relPath) {
  return fs.readFileSync(path.resolve(root, relPath), 'utf8');
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
    .filter((relPath) => fs.existsSync(path.join(root, relPath)))
    .map((relPath) => ({ relPath, absPath: path.join(root, relPath) }));
}

function isRuntimeSource(relPath) {
  if (relPath.startsWith('sharedmodule/llmswitch-core/scripts/tests/')) return false;
  if (relPath.startsWith('sharedmodule/llmswitch-core/tests/')) return false;
  return relPath.startsWith('src/') || relPath.startsWith('sharedmodule/');
}

function isNativeLoaderBridge(relPath) {
  return relPath.startsWith(allowedNativeLoaderBridgePrefix) && relPath.endsWith('.ts');
}

function importsBroadNativeExports(source) {
  return /from\s+['"][^'"]*native-exports(?:\.js|\.ts)?['"]/u.test(source)
    || /import\s*\([^)]*['"][^'"]*native-exports(?:\.js|\.ts)?['"][^)]*\)/u.test(source)
    || /jest\.unstable_mockModule\s*\([^)]*['"][^'"]*native-exports(?:\.js|\.ts)?['"]/su.test(source)
    || /jest\.mock\s*\([^)]*['"][^'"]*native-exports(?:\.js|\.ts)?['"]/su.test(source);
}

function usesCreateNativeExportsMock(source) {
  return /\bcreateNativeExportsMock\b/u.test(source);
}

function importsBroadNativeExportsFake(source) {
  return /from\s+['"][^'"]*llmswitch-native-exports-fake(?:\.js|\.ts)?['"]/u.test(source)
    || /import\s*\([^)]*['"][^'"]*llmswitch-native-exports-fake(?:\.js|\.ts)?['"][^)]*\)/u.test(source);
}

function importsDirectNativeHelper(source) {
  return /from\s+['"][^'"]*(?:tests\/sharedmodule\/helpers|scripts\/helpers)\/[^'"]*direct-native[^'"]*['"]/u.test(source)
    || /import\s*\([^)]*['"][^'"]*(?:tests\/sharedmodule\/helpers|scripts\/helpers)\/[^'"]*direct-native[^'"]*['"][^)]*\)/u.test(source);
}

function hasStaleDocOwnerSurface(source) {
  const lines = source.split('\n');
  return lines.some((line) =>
    /\b(owner|owner surface|semantic owner|truth owner|owner module)\b/i.test(line)
      && /\bnative-exports(?:\.ts)?\b/u.test(line)
      && !/\b(private loader|forbidden|retired|legacy|must not|不得|禁止)\b/i.test(line)
  );
}

function validateMaps() {
  const functionMap = YAML.parse(readText(functionMapPath));
  const verificationMap = YAML.parse(readText(verificationMapPath));
  const packageJson = JSON.parse(readText(packageJsonPath));
  const packageScripts = packageJson.scripts ?? {};

  const owner = (functionMap?.owners ?? []).find((row) => row?.feature_id === closeoutFeatureId);
  if (!owner) {
    failures.push(`function-map missing feature_id: ${closeoutFeatureId}`);
  } else {
    const requiredGates = Array.isArray(owner.required_gates) ? owner.required_gates : [];
    for (const gate of [
      'npm run verify:hub-pipeline-native-reference-gate',
      'npm run test:hub-pipeline-native-reference-gate-red-fixtures',
    ]) {
      if (!requiredGates.includes(gate)) {
        failures.push(`function-map ${closeoutFeatureId}: missing required gate ${gate}`);
      }
    }
  }

  const verification = (verificationMap?.verification ?? []).find(
    (row) => row?.feature_id === closeoutFeatureId
  );
  if (!verification) {
    failures.push(`verification-map missing feature_id: ${closeoutFeatureId}`);
  }

  for (const scriptName of [
    'verify:hub-pipeline-native-reference-gate',
    'test:hub-pipeline-native-reference-gate-red-fixtures',
  ]) {
    if (!Object.hasOwn(packageScripts, scriptName)) {
      failures.push(`package.json missing script: ${scriptName}`);
    }
  }
}

function verifyHubPipelineNativeReferenceGate() {
  validateMaps();

  for (const { relPath, absPath } of listTrackedOrFixtureFiles()) {
    const source = fs.readFileSync(absPath, 'utf8');

    if (
      isRuntimeSource(relPath)
      && importsBroadNativeExports(source)
      && !allowedRuntimeBroadImportFiles.has(relPath)
      && !isNativeLoaderBridge(relPath)
    ) {
      failures.push(`${relPath}: runtime source imports broad native-exports; use owner-specific narrow host`);
    }

    if (monitoredWhiteBoxTests.includes(relPath)) {
      const importsForbiddenBroadFake = monitoredBroadFakeHelperTests.has(relPath)
        && importsBroadNativeExportsFake(source);
      if (importsBroadNativeExports(source) || usesCreateNativeExportsMock(source) || importsForbiddenBroadFake) {
        failures.push(`${relPath}: monitored white-box test must mock owner-specific host, not broad native-exports`);
      }
    }

    if (isRuntimeSource(relPath) && importsDirectNativeHelper(source)) {
      failures.push(`${relPath}: runtime source imports direct-native evidence helper`);
    }

    if (relPath.startsWith('docs/architecture/wiki/') && /\.md$/u.test(relPath) && hasStaleDocOwnerSurface(source)) {
      failures.push(`${relPath}: doc/wiki owner surface names broad native-exports as owner`);
    }
  }
}

verifyHubPipelineNativeReferenceGate();

if (failures.length > 0) {
  console.error('[verify:hub-pipeline-native-reference-gate] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:hub-pipeline-native-reference-gate] ok');
console.log('- broad native external callers, white-box mocks, runtime direct-native imports, doc owner surfaces, and map bindings checked');
