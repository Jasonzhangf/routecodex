import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Replays the two saved red-case client captures through the observer and the
// tool consumer. It reads only already-saved bytes; it does not call a runtime,
// does not rewrite the cases, and does not fabricate calls.
const argv = process.argv.slice(2);
const options = { repo: '/Volumes/Intel/playground/routecodex/magpie-live-matrix-20261012' };
for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i]?.replace(/^--/, '');
  const value = argv[i + 1];
  if (!value) throw new Error(`missing value for --${key}`);
  if (key === 'repo') options.repo = resolve(value);
  else throw new Error(`unknown argument --${key}`);
}

const helperRoot = resolve(options.repo, 'v3/scripts/tests/protocol-live-mock');
const { parseClientBody } = await import(`file://${helperRoot}/protocol-semantics.mjs`);
const { extractToolCalls } = await import(`file://${helperRoot}/tool-consumer.mjs`);

const base = resolve(options.repo, 'docs/reports/magpie-live-matrix/installed-baseline-20261012');
const entryProtocolFor = (path) => {
  if (path.includes('/v1/responses')) return 'responses';
  if (path.includes('/v1/chat/completions')) return 'openai_chat';
  if (path.includes('/v1/messages')) return 'anthropic';
  return 'gemini';
};

function observe(caseId, turn) {
  const path = resolve(base, caseId, 'captures', `${caseId}-turn-${turn}-client.json`);
  const capture = JSON.parse(readFileSync(path, 'utf8'));
  const response = capture.client_response ?? {};
  const entryProtocol = entryProtocolFor(capture.request?.path ?? response.url ?? '');
  const headers = response.headers ?? {};
  const bodyText = response.bodyText ?? '';
  const parsed = parseClientBody(entryProtocol, bodyText, headers['content-type'] ?? '');
  const calls = extractToolCalls(entryProtocol, { bodyText, headers });
  return { path, entryProtocol, status: response.status ?? null, bodyText, parsed, calls };
}

const report = { cases: [] };
for (const [caseId, turn] of [['tool-followup-responses-to-chat', 1], ['namespace-custom-complete-args', 1]]) {
  const o = observe(caseId, turn);
  const outputItems = o.parsed.semantic?.output_items ?? [];
  const entry = {
    case_id: caseId,
    turn,
    client_status: o.status,
    body_len: o.bodyText.length,
    parse_kind: o.parsed.kind,
    parse_ok: o.parsed.ok,
    output_item_count: outputItems.length,
    output_item_call_ids: outputItems.map((item) => item.call_id ?? item.id ?? null),
    observed_tool_calls: o.calls,
  };
  report.cases.push(entry);
  console.log(JSON.stringify(entry, null, 2));
}

console.log(`\nSUMMARY ${JSON.stringify(report.cases.map((c) => ({ case_id: c.case_id, status: c.client_status, calls: c.observed_tool_calls.length })))}`);
