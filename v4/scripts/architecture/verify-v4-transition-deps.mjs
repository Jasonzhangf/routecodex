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
const recordGraphPath = path.join(v4Root, 'contracts/records/record-graph.contract.json');

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

// Requirements beyond the record graph order that the zone manifest still
// declares at the promotion boundary.
const ADDITIONAL_PROMOTION_REQUIREMENTS = [
  'scenario_composition_verified',
  'compile',
  'promotion_record',
];

// Lifecycle steps that are not zone transition requirements. They still stay
// in the canonical record graph, but the zone manifest has no matching knob.
const NON_ZONE_RECORD_STEPS = new Set(['collaboration_claimed']);

const ZONE_REQUIREMENT_BY_RECORD_STEP = {
  clean_worktree: 'clean_worktree',
  baseline_reproduction: 'baseline_reproduction',
  fix_candidate_verified: 'fix_candidate_verified',
  development_whitebox_pass: 'development_whitebox_pass',
  deployed_blackbox_pass: 'deployed_blackbox_pass',
  pre_review_validation_pass: 'pre_review_validation_pass',
  architecture_review_pass: 'architecture_review_pass',
  post_architecture_effectiveness_pass: 'post_architecture_effectiveness_pass',
  merge_queued: 'merge_queue_admitted_when_parallel',
  integration_verified: 'tested_integration_verified_when_parallel',
  remote_verified: 'local_and_remote_mainline_receipt_when_parallel',
  mainline_merged: 'mainline_merge_verified',
  scenario_composition_verified: 'scenario_composition_verified',
  compile: 'compile',
  promotion_record: 'promotion_record',
};

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

function requiredPromotionRequirements(recordGraph) {
  const lifecycle = recordGraph?.properties?.fix_lifecycle?.properties;
  const singleOrder = lifecycle?.single_order?.const;
  const parallelOrder = lifecycle?.parallel_order?.const;
  if (!Array.isArray(singleOrder) || !Array.isArray(parallelOrder)) {
    return null;
  }
  const parallelOnly = parallelOrder.filter((entry) => !singleOrder.includes(entry));
  const requiredSteps = [...singleOrder, ...parallelOnly, ...ADDITIONAL_PROMOTION_REQUIREMENTS];
  return [...new Set(
    requiredSteps
      .map((step) => ZONE_REQUIREMENT_BY_RECORD_STEP[step])
      .filter((requirement) => requirement !== undefined),
  )];
}

function unmappedPromotionSteps(recordGraph) {
  const lifecycle = recordGraph?.properties?.fix_lifecycle?.properties;
  const singleOrder = lifecycle?.single_order?.const;
  const parallelOrder = lifecycle?.parallel_order?.const;
  if (!Array.isArray(singleOrder) || !Array.isArray(parallelOrder)) {
    return [];
  }
  const parallelOnly = parallelOrder.filter((entry) => !singleOrder.includes(entry));
  const requiredSteps = [...singleOrder, ...parallelOnly, ...ADDITIONAL_PROMOTION_REQUIREMENTS];
  return [...new Set(
    requiredSteps.filter(
      (step) =>
        !NON_ZONE_RECORD_STEPS.has(step)
        && !Object.hasOwn(ZONE_REQUIREMENT_BY_RECORD_STEP, step),
    ),
  )];
}

export function validateTransitionContract(lifecycle, zone, recordGraph) {
  const failures = [];
  const unmapped = unmappedPromotionSteps(recordGraph);
  if (unmapped.length > 0) {
    failures.push(`record graph promotion steps must map to zone requirements, unmapped: ${unmapped.join(', ')}`);
  }
  const promotionRequirements = requiredPromotionRequirements(recordGraph);
  if (!promotionRequirements) {
    failures.push('record graph must define fix_lifecycle.single_order and fix_lifecycle.parallel_order arrays');
  }
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
    if (!Array.isArray(active.requirements)) {
      failures.push('playground -> active must declare requirements array');
    } else if (promotionRequirements) {
      const missingRequirements = missingMembers(active.requirements, promotionRequirements);
      if (missingRequirements.length > 0) {
        failures.push(
          `playground -> active must require full promotion prerequisites, missing: ${missingRequirements.join(', ')}`,
        );
      }
    }
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
    recordGraph: JSON.parse(fs.readFileSync(recordGraphPath, 'utf8')),
  };
}

function runProduction() {
  const { lifecycle, zone, recordGraph } = load();
  const failures = validateTransitionContract(lifecycle, zone, recordGraph);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`[V4-TRANSITION-DEPS] FAIL ${failure}`);
    process.exit(1);
  }
  console.log('[V4-TRANSITION-DEPS] OK release promotion and freeze dependencies');
}

function expectReject(mutate, expected) {
  const { lifecycle, zone, recordGraph } = load();
  const mutated = JSON.parse(JSON.stringify({ lifecycle, zone, recordGraph }));
  mutate(mutated);
  const failures = validateTransitionContract(mutated.lifecycle, mutated.zone, mutated.recordGraph);
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
    const active = manifest.zone.transitions.find((entry) => entry.from === 'playground' && entry.to === 'active');
    active.requirements = active.requirements.filter((requirement) => requirement !== 'clean_worktree');
  }, 'must require full promotion prerequisites');
  expectReject((manifest) => {
    const active = manifest.zone.transitions.find((entry) => entry.from === 'playground' && entry.to === 'active');
    active.requirements = active.requirements.join(' ');
  }, 'must declare requirements array');
  expectReject((manifest) => {
    manifest.recordGraph.properties.fix_lifecycle.properties.parallel_order.const = [
      ...manifest.recordGraph.properties.fix_lifecycle.properties.parallel_order.const,
      'security_review_pass',
    ];
  }, 'must map to zone requirements');
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
