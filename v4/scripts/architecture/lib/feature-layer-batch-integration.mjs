import path from 'node:path';
import {
  TASK_READY_STATUS,
  addFailure,
  isMachinePath,
  sameOrdered,
  sortedUnique,
} from './feature-layer-batch-contract.mjs';
import { FULL_COMMIT_PATTERN, canonicalJson } from './feature-layer-batch-git.mjs';

const QUEUE_STATE_KEYS = ['active_entry_id', 'merge_owner', 'ordered_entry_ids'];
const QUEUE_RECORD_KEYS = [
  'candidate_commit', 'collaboration_id', 'created_at', 'delivery_mode', 'effectiveness_id',
  'fix_candidate_id', 'issue_id', 'main_base_commit', 'merge_owner', 'milestone_id',
  'module_id', 'queue_entry_id', 'queue_position', 'status', 'strategy',
];
const INTEGRATION_RECORD_KEYS = [
  'candidate_commit', 'conflict_status', 'created_at', 'impact_status', 'integration_commit',
  'integration_id', 'integration_tree_hash', 'issue_id', 'main_base_commit', 'milestone_id',
  'module_id', 'queue_entry_id', 'required_gate_results', 'resolution_mode', 'result',
];
const GATE_RESULT_KEYS = ['gate_id', 'producer', 'result', 'source_commit', 'tree_hash'];

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && sameOrdered(Object.keys(value).sort(), [...expected].sort());
}

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0;
}

function validPastDate(value, now) {
  const timestamp = Date.parse(value ?? '');
  return Number.isFinite(timestamp) && timestamp <= now;
}

function readJsonAt(truth, commit, relativePath, failures, code) {
  const identity = truth.blobIdentity(commit, relativePath);
  const bytes = identity ? truth.blob(commit, relativePath) : null;
  if (!identity || bytes === null) {
    addFailure(failures, code, `${relativePath}: tracked regular JSON blob is required`);
    return null;
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    addFailure(failures, code, `${relativePath}: ${error.message}`);
    return null;
  }
}

function candidateRecords(manifest, truth, head, failures) {
  const records = [];
  const paths = sortedUnique((manifest.batches ?? []).flatMap((batch) => (batch.tasks ?? [])
    .filter((task) => task.status === TASK_READY_STATUS)
    .map((task) => task.candidate_record)
    .filter(isMachinePath)));
  for (const recordPath of paths) {
    const record = readJsonAt(truth, head, recordPath, failures, 'INTEGRATION_CANDIDATE_RECORD_INVALID');
    if (!record
        || !nonEmpty(record.fix_candidate_id)
        || !nonEmpty(record.issue_id)
        || !nonEmpty(record.module_id)
        || !FULL_COMMIT_PATTERN.test(record.head_commit ?? '')) {
      addFailure(failures, 'INTEGRATION_CANDIDATE_RECORD_INVALID',
        `${recordPath}: candidate queue identity is incomplete`);
      continue;
    }
    records.push({ path: recordPath, record });
  }
  const commits = records.map(({ record }) => record.head_commit);
  if (sortedUnique(commits).length !== commits.length) {
    addFailure(failures, 'INTEGRATION_CANDIDATE_SET', 'candidate commits must be unique queue inputs');
  }
  return records;
}

function expectedProducer(gate) {
  return `${gate?.producer?.adapter ?? ''}:${gate?.producer?.identity ?? ''}`;
}

export function validateIntegrationRecords({
  manifest,
  input,
  context,
  failures,
  expectedGateIds,
}) {
  if (!manifest.integration.wiring_started) return;
  const refs = manifest.integration.resource_refs;
  if (refs.merge_queue_state !== '.appsdk/records/merge-queue-state.json'
      || !isMachinePath(refs.integration_candidate)
      || !/^\.appsdk\/records\/integration-record-[A-Za-z0-9._-]+\.json$/
        .test(refs.integration_candidate)) {
    addFailure(failures, 'INTEGRATION_RESOURCE_RECORDS',
      'wiring requires canonical merge queue and integration record paths');
    return;
  }
  const truth = context.truth;
  const head = truth.currentHead();
  const queueState = readJsonAt(truth, head, refs.merge_queue_state, failures, 'MERGE_QUEUE_RECORD_INVALID');
  const integration = readJsonAt(truth, head, refs.integration_candidate, failures, 'INTEGRATION_RECORD_INVALID');
  if (!queueState || !integration) return;
  if (!exactKeys(queueState, QUEUE_STATE_KEYS)
      || queueState.merge_owner !== 'appsdk::merge_queue'
      || !Array.isArray(queueState.ordered_entry_ids)
      || queueState.ordered_entry_ids.length === 0
      || sortedUnique(queueState.ordered_entry_ids).length !== queueState.ordered_entry_ids.length
      || queueState.active_entry_id !== queueState.ordered_entry_ids.at(-1)) {
    addFailure(failures, 'MERGE_QUEUE_STATE_IDENTITY',
      'merge queue state must be unique, ordered, and owned by AppSDK');
    return;
  }
  if (!exactKeys(integration, INTEGRATION_RECORD_KEYS)
      || path.basename(refs.integration_candidate) !== `integration-record-${integration.integration_id}.json`
      || !nonEmpty(integration.integration_id)
      || !validPastDate(integration.created_at, context.now)) {
    addFailure(failures, 'INTEGRATION_RECORD_SCHEMA', 'integration record shape/path/time is invalid');
    return;
  }
  const queueRecords = [];
  const queuePaths = [];
  for (const [index, queueEntryId] of queueState.ordered_entry_ids.entries()) {
    if (!/^[A-Za-z0-9._-]+$/.test(queueEntryId)) {
      addFailure(failures, 'MERGE_QUEUE_ENTRY_ID', `${queueEntryId}: unsafe queue entry id`);
      continue;
    }
    const queuePath = `.appsdk/records/merge-queue-record-${queueEntryId}.json`;
    const record = readJsonAt(truth, head, queuePath, failures, 'MERGE_QUEUE_ENTRY_INVALID');
    queuePaths.push(queuePath);
    if (!record) continue;
    if (!exactKeys(record, QUEUE_RECORD_KEYS)
        || record.queue_entry_id !== queueEntryId
        || record.queue_position !== index + 1
        || record.merge_owner !== queueState.merge_owner
        || record.delivery_mode !== 'commit_merge_each_milestone'
        || record.strategy !== 'integration_merge_then_fast_forward'
        || record.status !== 'admitted'
        || !FULL_COMMIT_PATTERN.test(record.candidate_commit ?? '')
        || !FULL_COMMIT_PATTERN.test(record.main_base_commit ?? '')
        || !validPastDate(record.created_at, context.now)
        || ![record.issue_id, record.module_id, record.collaboration_id, record.milestone_id,
          record.fix_candidate_id, record.effectiveness_id].every(nonEmpty)) {
      addFailure(failures, 'MERGE_QUEUE_ENTRY_IDENTITY', `${queueEntryId}: queue record is invalid`);
      continue;
    }
    queueRecords.push(record);
  }
  const candidates = candidateRecords(manifest, truth, head, failures);
  const candidateCommits = sortedUnique(candidates.map(({ record }) => record.head_commit));
  const queuedCommits = sortedUnique(queueRecords.map((record) => record.candidate_commit));
  if (!sameOrdered(candidateCommits, queuedCommits)) {
    addFailure(failures, 'INTEGRATION_CANDIDATE_SET',
      'merge queue must contain every and only source-green candidate commit');
  }
  for (const { record: candidate } of candidates) {
    const queueRecord = queueRecords.find((record) => record.candidate_commit === candidate.head_commit);
    if (!queueRecord
        || queueRecord.fix_candidate_id !== candidate.fix_candidate_id
        || queueRecord.issue_id !== candidate.issue_id
        || queueRecord.module_id !== candidate.module_id) {
      addFailure(failures, 'MERGE_QUEUE_CANDIDATE_IDENTITY',
        `${candidate.head_commit}: queue record differs from candidate identity`);
    }
  }
  const active = queueRecords.find((record) => record.queue_entry_id === queueState.active_entry_id);
  const testedCommit = truth.resolveCommit(integration.integration_commit);
  const testedTree = testedCommit ? truth.treeHash(testedCommit) : null;
  if (!active
      || !testedCommit
      || !truth.isAncestor(testedCommit, head)
      || integration.queue_entry_id !== active.queue_entry_id
      || integration.milestone_id !== active.milestone_id
      || integration.issue_id !== active.issue_id
      || integration.module_id !== active.module_id
      || integration.candidate_commit !== active.candidate_commit
      || integration.main_base_commit !== active.main_base_commit
      || integration.integration_tree_hash !== testedTree
      || integration.conflict_status !== 'clean'
      || integration.resolution_mode !== 'none'
      || !['unchanged', 'revalidated'].includes(integration.impact_status)
      || integration.result !== 'pass'
      || candidateCommits.some((commit) => !truth.isAncestor(commit, testedCommit))) {
    addFailure(failures, 'INTEGRATION_RECORD_IDENTITY',
      'integration record must bind the tested descendant of every queued candidate');
    return;
  }
  const gateMap = new Map(input.verificationMap.gates.map((gate) => [gate.gate_id, gate]));
  const receipts = integration.required_gate_results;
  if (!Array.isArray(receipts)
      || !sameOrdered(sortedUnique(receipts.map((receipt) => receipt.gate_id)), expectedGateIds)
      || receipts.length !== expectedGateIds.length
      || receipts.some((receipt) => !exactKeys(receipt, GATE_RESULT_KEYS)
        || receipt.result !== 'pass'
        || receipt.source_commit !== testedCommit
        || receipt.tree_hash !== testedTree
        || receipt.producer !== expectedProducer(gateMap.get(receipt.gate_id)))) {
    addFailure(failures, 'INTEGRATION_GATE_RECEIPTS',
      'integration receipts must exactly bind every directly rerun gate to the tested tree');
  }
  const allowedBookkeeping = new Set([
    refs.merge_queue_state,
    refs.integration_candidate,
    ...queuePaths,
  ].map((relativePath) => `v4/${relativePath}`));
  const postTestChanges = truth.changedPaths(testedCommit, head);
  if (!postTestChanges.includes(`v4/${refs.integration_candidate}`)
      || postTestChanges.some((changedPath) => !allowedBookkeeping.has(changedPath))) {
    addFailure(failures, 'INTEGRATION_POST_TEST_DRIFT',
      'HEAD after the tested commit may contain only typed merge/integration bookkeeping');
  }
  for (const surface of manifest.integration.guarded_surfaces ?? []) {
    try {
      if (truth.currentScopeHash([surface.path]) !== truth.scopeHashAt(testedCommit, [surface.path])) {
        addFailure(failures, 'INTEGRATION_GUARDED_SURFACE_DRIFT',
          `${surface.path}: current product surface differs from the tested commit`);
      }
    } catch (error) {
      addFailure(failures, 'INTEGRATION_GUARDED_SURFACE_DRIFT', `${surface.path}: ${error.message}`);
    }
  }
}
