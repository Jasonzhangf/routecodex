import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLOSURE_GATE_ID,
  manifestProjection,
  RUNTIME_FEATURE_ID,
  sourceInputsEqual,
} from '../architecture/produce-v4-feature-layer-evidence.mjs';
import { isClosureDecisionAlias } from '../architecture/lib/feature-layer-batch-evidence.mjs';

test('not-needed decision reuses the single closure gate', () => {
  const gate = { gate_id: CLOSURE_GATE_ID, evidence_role: 'closure_audit' };
  assert.equal(isClosureDecisionAlias({ role: 'not_needed_decision', gate_id: CLOSURE_GATE_ID }, gate), true);
  assert.equal(isClosureDecisionAlias({ role: 'closure_audit', gate_id: CLOSURE_GATE_ID }, gate), false);
  assert.equal(isClosureDecisionAlias({ role: 'not_needed_decision', gate_id: 'other' }, gate), false);
  assert.equal(isClosureDecisionAlias({ role: 'not_needed_decision', gate_id: CLOSURE_GATE_ID }, null), false);
});

test('no-gap projection closes R002 and leaves H without source claims', () => {
  const manifest = {
    baseline: { evidence_refs: [] },
    prerequisites: [{ feature_id: RUNTIME_FEATURE_ID }],
    batches: [{
      batch_id: 'H',
      conditional: true,
      owner_binding_status: 'pending',
      owner_function_id: null,
      module_ids: [],
      owned_paths: [],
      source_dependencies: [],
      status: 'pending',
      tasks: [{ task_id: RUNTIME_FEATURE_ID }],
    }],
  };
  const projected = manifestProjection(
    manifest,
    'docs/evidence/feature-completion/M1/V4-CURRENT-TREE/baseline-replay-current.json',
    'docs/evidence/feature-completion/M1/V4-RUNTIME-002/closure-audit-current.json',
    'docs/evidence/feature-completion/M1/V4-RUNTIME-002/not-needed-decision-current.json',
    'a'.repeat(40),
  );
  const task = projected.batches[0].tasks[0];
  assert.equal(projected.prerequisites[0].status, 'pass');
  assert.equal(projected.prerequisites[0].gap_detected, false);
  assert.equal(projected.prerequisites[0].epoch_closure_lane_status, 'not_needed_by_evidence');
  assert.equal(projected.prerequisites[0].audit_commit, 'a'.repeat(40));
  assert.equal(projected.batches[0].status, 'not_needed_by_evidence');
  assert.equal(task.status, 'not_needed_by_evidence');
  assert.equal(task.candidate_record, null);
  assert.deepEqual(task.function_ids, []);
  assert.deepEqual(task.resource_ids, []);
  assert.deepEqual(task.source_paths, []);
  assert.deepEqual(task.required_gate_ids, []);
  assert.deepEqual(task.evidence_refs, [{
    role: 'not_needed_decision',
    gate_id: CLOSURE_GATE_ID,
    path: 'docs/evidence/feature-completion/M1/V4-RUNTIME-002/not-needed-decision-current.json',
  }]);
});

test('source inputs remain reusable across evidence-only commits', () => {
  const sourcePaths = ['crates/runtime/src/lib.rs', 'crates/runtime/tests/l2.rs'];
  const firstCommit = 'a'.repeat(40);
  const secondCommit = 'b'.repeat(40);
  const sourceBytes = new Map([
    [firstCommit, new Map(sourcePaths.map((sourcePath) => [sourcePath, `stable:${sourcePath}`]))],
    [secondCommit, new Map(sourcePaths.map((sourcePath) => [sourcePath, `stable:${sourcePath}`]))],
  ]);
  const truth = {
    blobIdentity(commit, sourcePath) {
      const bytes = sourceBytes.get(commit)?.get(sourcePath);
      if (!bytes) return null;
      return {
        path: sourcePath,
        mode: '100644',
        git_oid: `oid:${bytes}`,
        sha256: `sha256:${bytes}`,
      };
    },
  };
  assert.equal(sourceInputsEqual(truth, firstCommit, secondCommit, sourcePaths), true);

  sourceBytes.get(secondCommit).set(sourcePaths[1], 'changed');
  assert.equal(sourceInputsEqual(truth, firstCommit, secondCommit, sourcePaths), false);
});
