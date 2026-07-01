#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function fail(message) {
  console.error(`[metadata-center-dualwrite-api] ${message}`);
  process.exitCode = 1;
}

const functionMap = read('docs/architecture/function-map.yml');
const verificationMap = read('docs/architecture/verification-map.yml');
const mainlineMap = read('docs/architecture/mainline-call-map.yml');
const manifest = read('docs/architecture/metadata-center-manifest.yml');
const dualwriteApi = read('src/server/runtime/http-server/metadata-center/dualwrite-api.ts');
const metadataCenter = read('src/server/runtime/http-server/metadata-center/metadata-center.ts');
const dualwriteTest = read('tests/server/runtime/http-server/metadata-center/metadata-center-dualwrite.spec.ts');
const runtimeControlWriter = read('sharedmodule/llmswitch-core/src/conversion/hub/metadata-center-runtime-control-writer.ts');
const rustDirectDecision = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs');
const rustReqGovernance = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs');
const rustStoplessSignals = read('sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_decision_context_signals.rs');
const tsRequestStageBridge = read('sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts');

const sourceRoots = ['src', 'sharedmodule/llmswitch-core/src', 'scripts'];
const directWriteCallPattern = /\b(?:\w+\.)?write(?:RequestTruth|ContinuationContext|RuntimeControl|ProviderObservation|ResponseObservation|CloseoutStatus|DebugSnapshot)\??\s*\(/g;
const allowedDirectWriteFiles = new Set([
  'src/server/runtime/http-server/metadata-center/dualwrite-api.ts',
  'sharedmodule/llmswitch-core/src/conversion/hub/metadata-center-runtime-control-writer.ts',
  'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing.ts',
  'sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.ts',
]);

function walkSourceFiles(dir, out = []) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) {
    return out;
  }
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'target' || entry.name === 'node_modules') {
      continue;
    }
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(rel, out);
      continue;
    }
    if (
      entry.isFile()
      && (rel.endsWith('.ts') || rel.endsWith('.js') || rel.endsWith('.mjs'))
      && !rel.endsWith('.d.ts')
    ) {
      out.push(rel);
    }
  }
  return out;
}

function stripTypeOnlyWriteSignatures(source) {
  return source
    .replace(/write(?:RequestTruth|ContinuationContext|RuntimeControl|ProviderObservation|ResponseObservation|CloseoutStatus|DebugSnapshot)\??:\s*\([^;]+?\)\s*=>\s*[^;]+;/gs, '')
    .replace(/^\s*write(?:RequestTruth|ContinuationContext|RuntimeControl|ProviderObservation|ResponseObservation|CloseoutStatus|DebugSnapshot)<[\s\S]*?^\s*\}\s*$/gm, '');
}

const liveSourceFiles = sourceRoots.flatMap((dir) => walkSourceFiles(dir));
for (const rel of liveSourceFiles) {
  const source = stripTypeOnlyWriteSignatures(read(rel));
  directWriteCallPattern.lastIndex = 0;
  if (!directWriteCallPattern.test(source)) {
    continue;
  }
  if (!allowedDirectWriteFiles.has(rel)) {
    fail(`direct MetadataCenter family write outside unified API/local migration shell: ${rel}`);
    continue;
  }
  if (rel !== 'src/server/runtime/http-server/metadata-center/dualwrite-api.ts' && !source.includes('function writeMetadataCenterSlot')) {
    fail(`migration shell with direct MetadataCenter write must expose local writeMetadataCenterSlot: ${rel}`);
  }
}

if (!functionMap.includes('feature_id: hub.metadata_center_dualwrite_api')) {
  fail('function-map missing hub.metadata_center_dualwrite_api');
}
if (!verificationMap.includes('feature_id: hub.metadata_center_dualwrite_api')) {
  fail('verification-map missing hub.metadata_center_dualwrite_api');
}
if (!mainlineMap.includes('metadata.center.mainline')) {
  fail('mainline-call-map missing metadata.center.mainline chain');
}
if (!mainlineMap.includes('owner_feature_id: hub.metadata_center_mainline')) {
  fail('mainline-call-map missing hub.metadata_center_mainline owner binding');
}
if (!manifest.includes('npm run verify:metadata-center-dualwrite-api')) {
  fail('metadata.center manifest missing dualwrite gate');
}

const closeoutPlanPath = 'docs/goals/metadata-center-request-scoped-closeout-plan.md';
if (!fs.existsSync(path.join(root, closeoutPlanPath))) {
  fail(`missing ${closeoutPlanPath}`);
}
if (!functionMap.includes(closeoutPlanPath)) {
  fail(`function-map missing closeout plan reference: ${closeoutPlanPath}`);
}
if (!verificationMap.includes(closeoutPlanPath)) {
  fail(`verification-map missing closeout plan reference: ${closeoutPlanPath}`);
}

const requiredPlannedTests = [
  'tests/server/runtime/http-server/metadata-center/metadata-center-dualwrite.spec.ts'
];
for (const rel of requiredPlannedTests) {
  if (!fs.existsSync(path.join(root, rel))) {
    fail(`planned dualwrite contract test missing: ${rel}`);
  }
}

const requiredApiNeedles = [
  'expectedScope?: MetadataCenterScope',
  'assertMetadataCenterScope',
  'scope mismatch',
  'requestId expected=',
  'sessionId expected=',
  'writeMetadataCenterSlot',
  'readMetadataCenterSlot',
  'buildMetadataCenterRustSnapshot',
  'applyMetadataCenterRustWriteResult',
  'responseObservation',
  'closeoutStatus'
];
for (const needle of requiredApiNeedles) {
  if (!dualwriteApi.includes(needle)) {
    fail(`dualwrite API missing scope contract needle: ${needle}`);
  }
}

const requiredLifecycleNeedles = [
  'METADATA_CENTER_SESSION_BUFFER_LIMIT = 10',
  'rememberReleasedMetadataCenter',
  'readReleasedMetadataCenterSessionBuffer',
  'releaseMetadataCenterForHttpResponse'
];
for (const needle of requiredLifecycleNeedles) {
  if (!metadataCenter.includes(needle)) {
    fail(`metadata center missing lifecycle buffer needle: ${needle}`);
  }
}

const requiredTestNeedles = [
  'applies Rust write result into both JS mirror and Rust-readable snapshot',
  'dual-writes explicit stopless migration mirror and compare context only when the API is asked to write them',
  'keeps runtime control isolated by request-local target and explicit request/session scope',
  'fails fast on request/session scope mismatch',
  'records released metadata in a bounded per-session lifecycle buffer',
  'toHaveLength(10)'
];
for (const needle of requiredTestNeedles) {
  if (!dualwriteTest.includes(needle)) {
    fail(`dualwrite contract test missing coverage needle: ${needle}`);
  }
}

if (!runtimeControlWriter.includes('writeMetadataCenterSlot')) {
  fail('runtime-control writer must use unified writeMetadataCenterSlot API');
}
if (!runtimeControlWriter.includes('function writeMetadataCenterSlot')) {
  fail('runtime-control writer must keep runtime-control writes behind a local writeMetadataCenterSlot shell');
}
if (runtimeControlWriter.includes('for (const [key, value] of Object.entries(args.runtimeControl)) {\n    if (value === undefined) {\n      continue;\n    }\n    bound.center.writeRuntimeControl')) {
  fail('runtime-control writer must not call center.writeRuntimeControl directly from the write loop');
}

const forbiddenRustTruthResidueNeedles = [
  {
    source: rustDirectDecision,
    needle: 'root.get("stopMessageEnabled")',
    label: 'direct decision top-level stopMessageEnabled truth read',
  },
  {
    source: rustDirectDecision,
    needle: 'root.get("stopMessageExcludeDirect")',
    label: 'direct decision top-level stopMessageExcludeDirect truth read',
  },
  {
    source: rustReqGovernance,
    needle: 'metadata\n            .get("stopMessageEnabled")',
    label: 'req governance top-level stopMessageEnabled truth read',
  },
  {
    source: rustStoplessSignals,
    needle: 'adapter_context.get("stopMessageEnabled")',
    label: 'stopless decision signals adapter-context top-level stopMessageEnabled truth read',
  },
  {
    source: rustStoplessSignals,
    needle: 'metadata.and_then(|row| row.get("stopMessageEnabled"))',
    label: 'stopless decision signals flat metadata stopMessageEnabled truth read',
  },
  {
    source: rustStoplessSignals,
    needle: 'runtime_metadata.and_then(|row| row.get("stopMessageEnabled"))',
    label: 'stopless decision signals runtime metadata stopMessageEnabled truth read',
  },
  {
    source: rustStoplessSignals,
    needle: 'runtime_metadata\n            .and_then(|row| row.get("runtime_control"))',
    label: 'stopless decision signals runtime metadata runtime_control truth read',
  },
  {
    source: rustStoplessSignals,
    needle: 'runtime_metadata.and_then(|row| row.get("stopMessagePortEnabled"))',
    label: 'stopless decision signals stopMessagePortEnabled truth read',
  }
];

for (const { source, needle, label } of forbiddenRustTruthResidueNeedles) {
  if (source.includes(needle)) {
    fail(`forbidden Rust truth residue present: ${label}`);
  }
}

const forbiddenTsTruthResidueNeedles = [
  {
    source: tsRequestStageBridge,
    needle: 'out.stopMessageEnabled = runtimeControl.stopMessageEnabled',
    label: 'request stage bridge top-level stopMessageEnabled projection',
  },
  {
    source: tsRequestStageBridge,
    needle: 'out.stopMessageExcludeDirect = runtimeControl.stopMessageExcludeDirect',
    label: 'request stage bridge top-level stopMessageExcludeDirect projection',
  }
];

for (const { source, needle, label } of forbiddenTsTruthResidueNeedles) {
  if (source.includes(needle)) {
    fail(`forbidden TS truth residue present: ${label}`);
  }
}

if (!process.exitCode) {
  console.log('[metadata-center-dualwrite-api] ok');
}
