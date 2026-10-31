// Focused oracle-integrity test for the older-turn tool-image case.
//
// Finding 3: the fixture's provider oracle previously rewarded dropping the
// intervening assistant turn, so it passed a body with that history removed and
// rejected the archived real capture that keeps it. This file pins the complete
// OpenAI Chat wire history as one independent literal constant, checks it
// through the public `assertProviderCaptures` API, accepts the archived real
// capture, and adds negative controls for lost or reordered assistant history
// and broken tool-result pairing. The expectation is never derived from the
// observed provider output.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { assertProviderCaptures } from './assertions.mjs';

const fixtureUrl = new URL(
  '../../../fixtures/protocol-live-mock-matrix/cases/media-anthropic-older-turn-tool-image.json',
  import.meta.url,
);
const archivedCaptureUrl = new URL(
  '../../../../docs/reports/magpie-live-matrix/installed-baseline-20261012/media-anthropic-older-turn-tool-image/provider-captures.json',
  import.meta.url,
);

const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
const archivedCaptures = JSON.parse(readFileSync(archivedCaptureUrl, 'utf8'));
const declaredOracle = fixture.expected_provider.body_must;

const imageUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// The current OpenAI Chat wire history the case must forward, as one literal
// independent expectation (not derived from any provider output index): the
// assistant tool_use keeps its exact call id/name/arguments, the tool_result
// stays paired by the same tool_call_id, the representable image is carried on
// the following user message, and the intervening assistant text plus the final
// user question keep their exact order.
const currentFullHistory = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'take a screenshot' },
      { type: 'image_url', image_url: { url: 'https://example.test/image.png' }, future_sibling: { occurrence: 1 } },
      { type: 'image_url', image_url: { url: 'https://example.test/image.png' }, future_sibling: { occurrence: 2 } },
    ],
  },
  {
    role: 'assistant',
    tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'screenshot', arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: 'toolu_1', content: [] },
  { role: 'user', content: [{ type: 'image_url', image_url: { url: imageUrl } }] },
  { role: 'assistant', content: [{ type: 'text', text: 'It shows a login page.' }] },
  { role: 'user', content: 'what colour was the button?' },
];

// The archived capture was produced before the text-part shape was pinned and
// keeps the same assistant text as a plain string. This historical expectation
// is independent of the current oracle and applies only to that archive.
const historicalFullHistory = [
  { role: 'user', content: 'take a screenshot' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'screenshot', arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: 'toolu_1', content: '' },
  { role: 'user', content: [{ type: 'image_url', image_url: { url: imageUrl } }] },
  { role: 'assistant', content: 'It shows a login page.' },
  { role: 'user', content: 'what colour was the button?' },
];

function captureFor(messages) {
  return { attempt_kind: 'business', body: { model: 'chat-model', messages, stream: false } };
}

function checkCurrentMessages(messages) {
  return assertProviderCaptures([captureFor(messages)], 0, { body_must: declaredOracle }, {
    providerProtocol: 'openai_chat',
  });
}

function checkHistoricalMessages(messages) {
  return assertProviderCaptures([captureFor(messages)], 0, {
    body_must: { messages: historicalFullHistory },
  }, {
    providerProtocol: 'openai_chat',
  });
}

test('older-turn tool-image oracle keeps the complete OpenAI Chat history', () => {
  // Feeding the literal history through the public assertion passes only if the
  // fixture's declared oracle is that full six-message history, so a shifted
  // subset that drops the intervening assistant turn can no longer pass.
  assert.deepEqual(checkCurrentMessages(currentFullHistory), { ok: true, diagnostics: [] });
});

test('archived real provider capture is accepted only with its historical assistant history intact', () => {
  const capture = archivedCaptures.find((entry) => entry.case_id === fixture.case_id);
  assert.ok(capture, 'archived capture for the case must exist');

  const accepted = assertProviderCaptures(archivedCaptures, 0, {
    paths: fixture.expected_provider.paths,
    method: fixture.expected_provider.method,
    auth_required: fixture.expected_provider.auth_required,
    body_must: { messages: historicalFullHistory },
  }, { providerProtocol: 'openai_chat' });
  assert.deepEqual(accepted, { ok: true, diagnostics: [] });

  // Removing the intervening assistant message (the old oracle's reward) must
  // now fail the same public assertion.
  const withoutAssistant = capture.body.messages.filter((message, index) => index !== 4);
  assert.equal(withoutAssistant.length, capture.body.messages.length - 1);
  const removed = checkHistoricalMessages(withoutAssistant);
  assert.equal(removed.ok, false);
  assert.ok(removed.diagnostics.includes('provider body_must messages mismatch'));
});

test('negative controls: removing or reordering the assistant turn fails', () => {
  const removed = currentFullHistory.filter((message, index) => index !== 4);
  const removal = checkCurrentMessages(removed);
  assert.equal(removal.ok, false);
  assert.ok(removal.diagnostics.includes('provider body_must messages mismatch'));

  const reordered = structuredClone(currentFullHistory);
  [reordered[4], reordered[5]] = [reordered[5], reordered[4]];
  const swap = checkCurrentMessages(reordered);
  assert.equal(swap.ok, false);
  assert.ok(swap.diagnostics.includes('provider body_must messages mismatch'));
});

test('negative control: breaking the tool-result pairing fails', () => {
  const unpaired = structuredClone(currentFullHistory);
  unpaired[2].tool_call_id = 'toolu_other';
  const result = checkCurrentMessages(unpaired);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.includes('provider body_must messages mismatch'));
});
