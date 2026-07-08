import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

const rustRequestCompat = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/responses/request.rs');
const requiredExports = read('sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts');
const directNativeHelper = read('tests/sharedmodule/helpers/compat-engine-direct-native.ts');
const functionMap = read('docs/architecture/function-map.yml');
const verificationMap = read('docs/architecture/verification-map.yml');
const legacyCompatActionsDir = path.join(
  root,
  'sharedmodule/llmswitch-core/src/conversion/compat/actions',
);

for (const required of [
  'normalize_responses_function_tools',
  'strip_responses_reasoning_content_for_provider_wire',
  'apply_responses_crs_request_compat',
  'row.remove("content")',
  'root.remove("temperature")',
]) {
  if (!rustRequestCompat.includes(required)) {
    failures.push(`rust request compat missing required truth: ${required}`);
  }
}

for (const required of [
  'runReqOutboundStage3CompatJson',
  'buildNativeReqOutboundCompatAdapterContextJson',
]) {
  if (!requiredExports.includes(required) && !directNativeHelper.includes(required)) {
    failures.push(`native request compat bridge missing: ${required}`);
  }
}

if (fs.existsSync(path.join(root, 'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-outbound-semantics.ts'))) {
  failures.push('native-hub-pipeline-req-outbound-semantics TS wrapper must stay physically deleted');
}

if (fs.existsSync(path.join(root, 'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.ts'))) {
  failures.push('compat-engine TS runtime shell must stay physically deleted');
}

if (fs.existsSync(path.join(root, 'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/native-adapter-context.ts'))) {
  failures.push('native-adapter-context TS runtime shell must stay physically deleted');
}

for (const required of [
  'feature_id: responses.request_compat_normalization',
  'feature_id: responses.crs_request_compat',
  'npm run verify:responses-request-compat-rust-only',
]) {
  if (!functionMap.includes(required) || !verificationMap.includes(required)) {
    failures.push(`map binding missing request compat feature artifact: ${required}`);
  }
}

const forbiddenRuntimeFiles = [
  'src/providers/core/runtime/responses-provider.ts',
  'src/server/runtime/http-server/direct-passthrough-payload.ts',
  'src/modules/llmswitch/bridge/native-exports.ts',
];

for (const relPath of forbiddenRuntimeFiles) {
  const source = read(relPath);
  for (const forbidden of [
    'responses:crs',
    'instructions")',
    'instructions\')',
  ]) {
    if (source.includes(forbidden)) {
      failures.push(`${relPath} must not own responses request compat truth: ${forbidden}`);
    }
  }
}

if (fs.existsSync(legacyCompatActionsDir)) {
  const entries = fs.readdirSync(legacyCompatActionsDir, { withFileTypes: true });
  const remainingTsActions = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => `sharedmodule/llmswitch-core/src/conversion/compat/actions/${entry.name}`)
    .sort();
  if (remainingTsActions.length > 0) {
    failures.push(
      [
        'legacy TS compat actions must stay physically removed; req_outbound provider-wire compat is Rust-owned',
        ...remainingTsActions.map((relPath) => `  - ${relPath}`),
      ].join('\n'),
    );
  }
  if (fs.existsSync(path.join(legacyCompatActionsDir, '__tests__'))) {
    failures.push('legacy TS compat actions self-tests must stay removed; Rust owner tests req_outbound_stage3_compat instead');
  }
}

const sourceRoots = [
  'sharedmodule/llmswitch-core/src',
  'src',
  'tests',
  'scripts',
];
for (const sourceRoot of sourceRoots) {
  const fullRoot = path.join(root, sourceRoot);
  if (!fs.existsSync(fullRoot)) {
    continue;
  }
  const stack = [fullRoot];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
        continue;
      }
      const relPath = path.relative(root, fullPath).split(path.sep).join('/');
      if (relPath === 'scripts/architecture/verify-responses-request-compat-rust-only.mjs') {
        continue;
      }
      if (relPath.startsWith('sharedmodule/llmswitch-core/src/conversion/compat/actions/')) {
        continue;
      }
      const source = fs.readFileSync(fullPath, 'utf8');
      if (
        /from\s+['"][^'"]*(?:conversion\/compat\/actions|compat\/actions)\//.test(source)
        || /import\s*\(\s*['"][^'"]*(?:conversion\/compat\/actions|compat\/actions)\//.test(source)
        || /require\s*\(\s*['"][^'"]*(?:conversion\/compat\/actions|compat\/actions)\//.test(source)
      ) {
        failures.push(`${relPath} must not import legacy TS compat action surfaces`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:responses-request-compat-rust-only] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:responses-request-compat-rust-only] ok');
console.log('- checked Rust request compat ownership, native bridge wiring, and architecture map bindings');
