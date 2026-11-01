import { readFileSync } from 'node:fs';
const real = await import('/Volumes/Intel/playground/routecodex/magpie-live-matrix-20261012/v3/scripts/tests/protocol-live-mock/protocol-semantics.mjs');
const old = await import('/tmp/ps-old.mjs');
const cap = JSON.parse(readFileSync('/Volumes/Intel/playground/routecodex/magpie-live-matrix-20261012/docs/reports/magpie-live-matrix/installed-baseline-20261012/tool-followup-responses-to-chat/captures/tool-followup-responses-to-chat-turn-1-client.json','utf8'));
const bodyText = cap.client_response.bodyText;
for (const [label, mod] of [['reverted(no-coalesce)', old], ['current(fixed)', real]]) {
  const parsed = mod.parseClientBody('responses', bodyText, 'text/event-stream');
  const items = parsed.semantic.output_items ?? [];
  console.log(label, 'output_items=', items.length, 'call_ids=', JSON.stringify(items.map(i => i.call_id ?? i.id ?? null)));
}
