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
const manifest = read('docs/architecture/manifests/metadata.center.mainline.yml');
const dualwriteApi = read('src/server/runtime/http-server/metadata-center/dualwrite-api.ts');
const metadataCenter = read('src/server/runtime/http-server/metadata-center/metadata-center.ts');
const dualwriteTest = read('tests/server/runtime/http-server/metadata-center/metadata-center-dualwrite.spec.ts');

if (!functionMap.includes('feature_id: hub.metadata_center_dualwrite_api')) {
  fail('function-map missing hub.metadata_center_dualwrite_api');
}
if (!verificationMap.includes('feature_id: hub.metadata_center_dualwrite_api')) {
  fail('verification-map missing hub.metadata_center_dualwrite_api');
}
if (!mainlineMap.includes('metadata-center-dualwrite-dualread-closeout-checklist.md')) {
  fail('mainline-call-map missing dualwrite closeout checklist binding');
}
if (!manifest.includes('npm run verify:metadata-center-dualwrite-api')) {
  fail('metadata.center manifest missing dualwrite gate');
}

const checklistPath = 'docs/goals/metadata-center-dualwrite-dualread-closeout-checklist.md';
if (!fs.existsSync(path.join(root, checklistPath))) {
  fail(`missing ${checklistPath}`);
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

if (!process.exitCode) {
  console.log('[metadata-center-dualwrite-api] ok');
}
