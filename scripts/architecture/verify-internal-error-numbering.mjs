#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function exists(relPath) {
  return fs.existsSync(path.join(root, relPath));
}

function listFiles(dir) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  const stack = [abs];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current)) {
      const full = path.join(current, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
      } else {
        out.push(path.relative(root, full));
      }
    }
  }
  return out.sort();
}

function assertContains(relPath, token) {
  if (!exists(relPath)) {
    failures.push(`missing required file: ${relPath}`);
    return;
  }
  const text = read(relPath);
  if (!text.includes(token)) {
    failures.push(`${relPath} missing token: ${token}`);
  }
}

const requiredFiles = [
  'src/debug/internal-error/index.ts',
  'src/debug/internal-error/registry.ts',
  'src/debug/internal-error/envelope.ts',
  'src/debug/internal-error/external-link.ts',
  'src/debug/internal-error/projection.ts',
  'src/debug/internal-error/guards.ts',
  'docs/architecture/wiki/internal-error-numbering-mainline-source.md',
  'docs/architecture/mainline-manifests/internal-error-numbering.mainline.yml',
  'docs/architecture/manifests/internal_error_numbering.mainline.yml',
  'tests/debug/internal-error-numbering.registry.spec.ts',
  'tests/debug/internal-error-numbering.envelope.spec.ts',
  'tests/debug/internal-error-numbering.external-boundary.spec.ts',
  'tests/debug/internal-error-numbering.leak-gate.spec.ts',
  'tests/architecture/internal-error-numbering-mainline.spec.ts',
];

for (const relPath of requiredFiles) {
  if (!exists(relPath)) failures.push(`missing required file: ${relPath}`);
}

const pkg = JSON.parse(read('package.json'));
if (pkg.scripts?.['verify:internal-error-numbering'] !== 'node scripts/architecture/verify-internal-error-numbering.mjs') {
  failures.push('package.json missing exact verify:internal-error-numbering script');
}

const functionMap = YAML.parse(read('docs/architecture/function-map.yml'));
const verificationMap = YAML.parse(read('docs/architecture/verification-map.yml'));
const mainline = YAML.parse(read('docs/architecture/mainline-call-map.yml'));
const knownFeatures = new Set((functionMap?.owners ?? []).map((row) => row?.feature_id).filter(Boolean));
if (!knownFeatures.has('debug.internal_error_numbering')) {
  failures.push('function-map missing feature_id: debug.internal_error_numbering');
}
if (!(verificationMap?.verification ?? []).some((row) => row?.feature_id === 'debug.internal_error_numbering')) {
  failures.push('verification-map missing feature_id: debug.internal_error_numbering');
}
const chain = (mainline?.chains ?? []).find((row) => row?.chain_id === 'internal_error_numbering.mainline');
if (!chain) {
  failures.push('mainline-call-map missing chain_id: internal_error_numbering.mainline');
} else if ((chain.edges ?? []).length !== 6) {
  failures.push(`internal_error_numbering.mainline must have 6 edges, got ${(chain.edges ?? []).length}`);
}

const manifest = YAML.parse(read('docs/architecture/mainline-manifests/internal-error-numbering.mainline.yml'));
if (manifest?.lifecycle_id !== 'internal_error_numbering.mainline') {
  failures.push('internal-error-numbering mainline manifest has wrong lifecycle_id');
}
for (const nodeId of [
  'IntErrNum01SourceObserved',
  'IntErrNum02ModuleBlockResolved',
  'IntErrNum03SubcodeAssigned',
  'IntErrNum04EnvelopeBuilt',
  'IntErrNum05DebugArtifactProjected',
  'IntErrNum06ExternalLinked',
  'IntErrNum07ClientBoundaryPreserved',
]) {
  if (!manifest?.node_ids?.includes(nodeId)) {
    failures.push(`internal-error-numbering manifest missing node_id: ${nodeId}`);
  }
}

const registryText = read('src/debug/internal-error/registry.ts');
const entryMatches = [...registryText.matchAll(/code:\s*'(500-[123]\d{2})'[\s\S]*?lane:\s*'(request|response|other)'[\s\S]*?nodeId:\s*'([^']+)'[\s\S]*?ownerFeatureId:\s*'([^']+)'/g)];
if (entryMatches.length === 0) {
  failures.push('registry has no internal error code entries');
}
const seenCodes = new Set();
for (const match of entryMatches) {
  const [, code, lane, nodeId, ownerFeatureId] = match;
  if (seenCodes.has(code)) failures.push(`duplicate registry code: ${code}`);
  seenCodes.add(code);
  const expectedLane = code.startsWith('500-1') ? 'request' : code.startsWith('500-2') ? 'response' : 'other';
  if (lane !== expectedLane) {
    failures.push(`registry code ${code} lane mismatch: expected ${expectedLane}, got ${lane}`);
  }
  if (!nodeId) failures.push(`registry code ${code} missing nodeId`);
  if (!knownFeatures.has(ownerFeatureId)) {
    failures.push(`registry code ${code} ownerFeatureId not in function-map: ${ownerFeatureId}`);
  }
}
for (const requiredCode of ['500-100', '500-200', '500-300']) {
  if (!seenCodes.has(requiredCode)) failures.push(`registry missing required lane seed code ${requiredCode}`);
}

const activeCodeLiteralFiles = listFiles('src')
  .filter((file) => file.endsWith('.ts') || file.endsWith('.js'))
  .filter((file) => !file.startsWith('src/debug/internal-error/'))
  .filter((file) => /500-[123]\d{2}/.test(read(file)));
for (const file of activeCodeLiteralFiles) {
  failures.push(`${file} contains ad hoc internal 500-* code literal outside src/debug/internal-error`);
}

for (const leakPath of [
  'src/server/utils/http-error-mapper.ts',
  ...listFiles('src/providers').filter((file) => file.endsWith('.ts') || file.endsWith('.js')),
  ...listFiles('sharedmodule/llmswitch-core').filter((file) => file.endsWith('.ts') || file.endsWith('.rs')),
]) {
  if (!exists(leakPath)) continue;
  const text = read(leakPath);
  if (text.includes('InternalDebugErrorEnvelope') || text.includes('internalError') || /500-[123]\d{2}/.test(text)) {
    failures.push(`${leakPath} must not leak or own internal debug error envelope`);
  }
}

assertContains('src/debug/index.ts', "export * from './internal-error/index.js';");
assertContains('src/debug/diag/error-artifact.ts', 'internalError?: InternalDebugErrorEnvelope');
assertContains('src/debug/diag/error-artifact.ts', 'externalError?: ExternalErrorLink');
assertContains('docs/architecture/wiki/internal-error-numbering-mainline-source.md', 'external errors are linked, not wrapped');

if (failures.length > 0) {
  console.error('[verify:internal-error-numbering] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:internal-error-numbering] PASS');
console.log(`- registry entries: ${entryMatches.length}`);
console.log('- request/response/other lane seeds present');
console.log('- external error boundary and leak scans passed');
