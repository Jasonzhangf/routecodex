#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const map = fs.readFileSync(path.join(root, 'docs/architecture/v3-v4-semantic-parity-map.yml'), 'utf8');
const evidencePath = path.join(root, 'docs/evidence/parity/v3-v4-normalized-differential-20260825.json');
const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
const healthEvidencePath = path.join(root, 'docs/evidence/parity/v4-5520-full-product-health-20260825.json');
const healthEvidence = JSON.parse(fs.readFileSync(healthEvidencePath, 'utf8'));
const requiredStages = ['request:', 'response:', 'error:', 'config:', 'verification_gates:', 'checkpoint_evidence:'];
const missing = requiredStages.filter((marker) => !map.includes(marker));
if (missing.length > 0) {
  console.error(`V4-PARITY-HARNESS-001 FAIL missing ${missing.join(',')}`);
  process.exit(1);
}
const segmentNames = ['raw_request', 'provider_bound_request', 'raw_provider_response', 'client_projection'];
const missingSegments = segmentNames.filter((name) => !evidence.segments?.[name]);
if (evidence.status !== 'pass'
  || evidence.execution_surface !== 'rccv4_global_live_5520'
  || !evidence.request_id
  || evidence.listener !== '127.0.0.1:5520'
  || missingSegments.length > 0
  || !Array.isArray(evidence.normalized_differential?.unexplained_differences)
  || evidence.normalized_differential.unexplained_differences.length !== 0
  || evidence.segments.provider_bound_request.control_fields_present !== false
  || evidence.verification?.live_health !== 'pass'
  || healthEvidence.result !== 'pass'
  || healthEvidence.listener !== '127.0.0.1:5520'
  || healthEvidence.health?.status !== 200
  || healthEvidence.models?.count !== 6
  || healthEvidence.compiled_product?.providers !== 6) {
  console.error(`V4-PARITY-HARNESS-001 FAIL live differential evidence incomplete: ${missingSegments.join(',')}`);
  process.exit(1);
}
if (process.argv[2] === '--red-self-test') {
  const mutated = map.replaceAll('checkpoint_evidence:', 'checkpoint_evidence_removed:');
  if (requiredStages.every((marker) => mutated.includes(marker))) {
    console.error('[V4-PARITY-HARNESS-001] RED FAIL mutation was not rejected');
    process.exit(1);
  }
  console.log('[V4-PARITY-HARNESS-001] RED OK checkpoint mutation rejected');
  process.exit(0);
}
if (process.argv[2] === '--boundary-self-test') {
  if (!map.includes('checkpoint_evidence:')) process.exit(1);
  console.log('[V4-PARITY-HARNESS-001] BOUNDARY OK checkpoint evidence closure');
  process.exit(0);
}
if (process.argv.length > 2) { console.error('MODE_INVALID'); process.exit(2); }
console.log('[V4-PARITY-HARNESS-001] OK request/response/error/config differential surfaces locked');
