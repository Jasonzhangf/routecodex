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
const rustDirectDecision = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs');
const rustReqGovernance = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs');
const rustStoplessSignals = read('sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_decision_context_signals.rs');
const tsRequestStageBridge = read('sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts');

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
  'sessionId expected='
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
