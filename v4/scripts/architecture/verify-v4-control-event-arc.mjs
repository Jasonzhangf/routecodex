#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const failures = [];
const events = readJson('contracts/v4-control-event-registry.json');
const ownership = readJson('contracts/v4-data-ownership-registry.json');
const control = fs.readFileSync(path.join(root, 'crates/routecodex-v4-control/src/lib.rs'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'crates/routecodex-v4-runtime/src/lib.rs'), 'utf8');
const expect = (ok, message) => { if (!ok) failures.push(message); };

expect(events.status === 'active', 'event registry is not active');
expect(ownership.status === 'active', 'ownership registry is not active');
expect(events.transport === 'ControlEventBus', 'event transport is not ControlEventBus');
expect(events.delivery_policies.includes('synchronous'), 'synchronous delivery is not registered');
for (const field of ['event_id', 'event_kind', 'producer', 'consumer', 'owner_node', 'sequence', 'causality_id', 'ack_required', 'terminal', 'release_point']) {
  expect(events.required_fields.includes(field), `event field missing: ${field}`);
}
for (const symbol of ['ControlEvent', 'ControlEventBus', 'ControlEventRegistry', 'ControlEventError', 'OwnerAcknowledgementRequired']) {
  expect(control.includes(symbol), `control symbol missing: ${symbol}`);
}
for (const symbol of ['ImmutableBytes', 'ImmutableRequest', 'ImmutableResponse', 'ImmutableProviderRaw', 'ImmutableSemantic', 'ImmutableWireBytes', 'ImmutableContinuationSnapshot']) {
  expect(runtime.includes(symbol), `immutable symbol missing: ${symbol}`);
}
expect(runtime.includes('Arc<[u8]>'), 'immutable carriers do not use Arc<[u8]>');
expect(!runtime.includes('Arc<Mutex<Value>>'), 'forbidden mutable JSON Arc appears');

if (process.argv.includes('--red-self-test')) {
  const eventRed = fs.readFileSync(path.join(root, 'crates/routecodex-v4-control/tests/l2_control_event_arc_red.rs'), 'utf8');
  const arcRed = fs.readFileSync(path.join(root, 'crates/routecodex-v4-runtime/tests/l2_immutable_arc_red.rs'), 'utf8');
  expect(eventRed.includes('DuplicateEvent') && eventRed.includes('SequenceGap') && eventRed.includes('ScopeMismatch'), 'event negative matrix incomplete');
  expect(eventRed.includes('OwnerAcknowledgementRequired') && eventRed.includes('DuplicateTerminal'), 'terminal negative matrix incomplete');
  expect(arcRed.includes('shares_allocation_with') && arcRed.includes('copy_count'), 'Arc ownership matrix incomplete');
}

if (failures.length) {
  console.error(`[v4 control-event-arc] FAIL\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`[v4 control-event-arc] OK events=${events.event_kinds.length} immutable=${ownership.resources.length}`);
