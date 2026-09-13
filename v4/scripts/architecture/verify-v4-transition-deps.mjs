#!/usr/bin/env node
/**
 * V4 transition dependency guard.
 *
 * The source lifecycle manifest must not carry a second stage graph: AppSDK's
 * installed lifecycle contract and v4/contracts/records/record-graph.contract.json
 * own the lifecycle order. This verifier only checks the project zone manifest
 * against that canonical release/freeze boundary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const v4Root = path.resolve(scriptDir, '..', '..');
const lifecyclePath = path.join(v4Root, 'contracts/lifecycle-state-machines.manifest.json');
const zonePath = path.join(v4Root, 'contracts/transitions/zone-transition-manifest.json');

// Promotion records that must be present at the playground -> active release
// boundary. Optional parallel records are checked separately because they
// only apply when the scenario pair is enabled.
const REQUIRED_PROMOTION_RECORDS = [
  'WorktreeRecord',
  'ReproductionRecord',
  'EvidenceRecordSet',
  'FixCandidateRecord',
  'PreReviewValidationRecord',
  'ArchitectureReviewRecord',
  'EffectivenessRecord',
  'MergeRecord',
  'PromotionRecord',
];

const ALLOWED_RECORDS = new Set([
  ...REQUIRED_PROMOTION_RECORDS,
  'EvidenceRecord',
  'FreezeRecord',
  'CollaborationRecordWhenParallel',
  'MergeQueueRecordWhenParallel',
  'IntegrationRecordWhenParallel',
  'MainlineReceiptRecordWhenParallel',
]);

function transition(zone, from, to) {
  return (zone.transitions ?? []).find((entry) => entry.from === from && entry.to === to);
}

function missingMembers(actual, expected) {
  return expected.filter((record) => !(actual ?? []).includes(record));
}

export function validateTransitionContract(lifecycle, zone) {
  const failures = [];
  if (lifecycle.stage_graph !== undefined) {
    failures.push('lifecycle state machine must not define stage_graph; use record-graph.contract.json and zone manifest');
  }
  if (zone.stage_graph !== undefined) {
    failures.push('zone transition contract must not define stage_graph');
  }
  if (!Array.isArray(zone.transitions)) {
    failures.push('zone.transitions must be an array');
    return failures;
  }

  const active = transition(zone, 'playground', 'active');
  if (!active) {
    failures.push('playground -> active transition is required');
  } else {
    const records = active.record_required;
    if (!Array.isArray(records)) {
      failures.push('playground -> active must declare record_required');
    } else {
      const missingPromotion = missingMembers(records, REQUIRED_PROMOTION_RECORDS);
      if (missingPromotion.length > 0) {
        failures.push(`playground -> active must require full promotion chain, missing: ${missingPromotion.join(', ')}`);
      }
      const unknown = records.filter((record) => !ALLOWED_RECORDS.has(record));
      if (unknown.length > 0) {
        failures.push(`playground -> active record_required contains unknown records: ${unknown.join(', ')}`);
      }
    }
  }

  const protectedEdge = transition(zone, 'active', 'protected');
  if (!protectedEdge) {
    failures.push('active -> protected transition is required');
  } else {
    const records = protectedEdge.record_required;
    if (!Array.isArray(records) || !records.includes('FreezeRecord')) {
      failures.push('active -> protected must require FreezeRecord');
    }
    if (!(protectedEdge.requirements ?? []).includes('freeze_record')) {
      failures.push('active -> protected requirements must include freeze_record');
    }
  }

  for (const entry of zone.transitions ?? []) {
    const unknown = (entry.record_required ?? []).filter((record) => !ALLOWED_RECORDS.has(record));
    if (unknown.length > 0) {
      failures.push(`${entry.from} -> ${entry.to} record_required contains unknown records: ${unknown.join(', ')}`);
    }
  }
  return failures;
}

function load() {
  return {
    lifecycle: JSON.parse(fs.readFileSync(lifecyclePath, 'utf8')),
    zone: JSON.parse(fs.readFileSync(zonePath, 'utf8')),
  };
}

function runProduction() {
  const { lifecycle, zone } = load();
  const failures = validateTransitionContract(lifecycle, zone);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`[V4-TRANSITION-DEPS] FAIL ${failure}`);
    process.exit(1);
  }
  console.log('[V4-TRANSITION-DEPS] OK release promotion and freeze dependencies');
}

function expectReject(mutate, expected) {
  const { lifecycle, zone } = load();
  const mutated = JSON.parse(JSON.stringify({ lifecycle, zone }));
  mutate(mutated);
  const failures = validateTransitionContract(mutated.lifecycle, mutated.zone);
  if (!failures.some((failure) => failure.includes(expected))) {
    throw new Error(`red fixture did not report ${expected}`);
  }
}

function runRedSelfTest() {
  expectReject((manifest) => {
    manifest.lifecycle.stage_graph = { order: [] };
  }, 'must not define stage_graph');
  expectReject((manifest) => {
    manifest.zone.stage_graph = manifest.lifecycle;
  }, 'must not define stage_graph');
  expectReject((manifest) => {
    const active = manifest.zone.transitions.find((entry) => entry.from === 'playground' && entry.to === 'active');
    active.record_required = ['PromotionRecord'];
  }, 'must require full promotion chain');
  expectReject((manifest) => {
    const active = manifest.zone.transitions.find((entry) => entry.from === 'playground' && entry.to === 'active');
    delete active.record_required;
  }, 'must declare record_required');
  expectReject((manifest) => {
    const protectedEdge = manifest.zone.transitions.find((entry) => entry.from === 'active' && entry.to === 'protected');
    protectedEdge.record_required = protectedEdge.record_required.filter((record) => record !== 'FreezeRecord');
  }, 'must require FreezeRecord');
  expectReject((manifest) => {
    const protectedEdge = manifest.zone.transitions.find((entry) => entry.from === 'active' && entry.to === 'protected');
    protectedEdge.requirements = protectedEdge.requirements.filter((requirement) => requirement !== 'freeze_record');
  }, 'must include freeze_record');
  console.log('[V4-TRANSITION-DEPS] RED OK');
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  if (process.argv.includes('--red-self-test')) {
    runRedSelfTest();
  } else {
    runProduction();
  }
}
