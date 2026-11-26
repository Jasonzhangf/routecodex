#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const cases = [
  ['responses-to-responses-sse', 'stop'],
  ['responses-to-responses-sse-completed-tool-no-reason', 'tool_calls'],
  ['responses-to-responses-sse-explicit-reason', 'content_filter'],
  ['responses-to-responses-json-completed-tool-no-reason', 'tool_calls'],
  ['responses-to-responses-json-explicit-reason', 'content_filter'],
];
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
function difference(a, b) {
  let offset = 0;
  while (offset < Math.min(a.length, b.length) && a[offset] === b[offset]) offset++;
  return { equal: a.equals(b), baseline_length: a.length, candidate_length: b.length,
    first_difference: a.equals(b) ? null : { offset, baseline_base64: a.subarray(Math.max(0, offset - 40), offset + 120).toString('base64'), candidate_base64: b.subarray(Math.max(0, offset - 40), offset + 120).toString('base64') } };
}
function body(value) {
  if (typeof value !== 'string' || !value.length) throw new Error('missing raw body capture');
  return Buffer.from(value, 'base64');
}
function withoutKeepalives(bytes) {
  // Remove only whole SSE comment-only frames. Every business frame and its
  // delimiters remain byte-for-byte. Raw comparison is reported separately.
  return Buffer.from(bytes.toString('latin1').replace(/(?:[^\r\n]*\r?\n)*\r?\n/g, (frame) => {
    const lines = frame.split(/\r?\n/).filter(Boolean);
    return lines.length && lines.every((line) => line.startsWith(':')) ? '' : frame;
  }), 'latin1');
}
export function compare(baseline, candidate) {
  const results = [];
  for (const [id, reason] of cases) {
    const left = join(baseline, id, id), right = join(candidate, id, id);
    const result = { case_id: id, expected_candidate_reason: reason, checks: [], errors: [] };
    try {
      const br = json(join(baseline, id, 'baseline-report.json'));
      const cr = json(join(candidate, id, 'baseline-report.json'));
      result.cleanup = { baseline: br.cleanup, candidate: cr.cleanup };
      if (br.status !== 'passed' || cr.status !== 'passed' || !br.cleanup.complete || !cr.cleanup.complete) result.errors.push('public case or cleanup failed');
      const files = readdirSync(join(left, 'captures')).filter((p) => p.endsWith('-client.json')).sort();
      if (!files.length) throw new Error('missing client capture');
      for (const file of files) {
        const b = json(join(left, 'captures', file)), c = json(join(right, 'captures', file));
        const request = difference(Buffer.from(b.request.body_text), Buffer.from(c.request.body_text));
        const bb = body(b.client_response.bodyBytesBase64), cb = body(c.client_response.bodyBytesBase64);
        const raw = difference(bb, cb);
        const business = id.includes('-sse') ? difference(withoutKeepalives(bb), withoutKeepalives(cb)) : raw;
        const completion = ['status', 'response_ended', 'complete', 'closed', 'aborted', 'error'].every((k) => JSON.stringify(b.client_response[k]) === JSON.stringify(c.client_response[k]));
        result.checks.push({ file, request, raw_client_body: raw, comment_only_keepalive_removed: business, completion });
        if (!request.equal || !business.equal || !completion) result.errors.push(`client/input/completion bytes differ: ${file}`);
      }
      const bp = json(join(left, 'provider-captures.json')), cp = json(join(right, 'provider-captures.json'));
      const business = (items) => items.filter((p) => !['startup', 'probe'].includes(p.attempt_kind));
      const ba = business(bp), ca = business(cp);
      result.attempts = { baseline: ba.length, candidate: ca.length, baseline_probes: bp.length - ba.length, candidate_probes: cp.length - ca.length };
      if (!ba.length || ba.length !== ca.length) result.errors.push('business attempt count differs or absent');
      result.provider = ba.map((b, i) => {
        const c = ca[i];
        if (!c) return { missing: true };
        const request = difference(Buffer.from(b.raw_body), Buffer.from(c.raw_body));
        const response = difference(body(b.response_wire?.bytes_base64), body(c.response_wire?.bytes_base64));
        const sequence_equal = ['attempt', 'turn', 'attempt_kind', 'path'].every((k) => b[k] === c[k]);
        if (!request.equal || !response.equal || !sequence_equal) result.errors.push(`provider request/wire/sequence differs: ${i}`);
        return { request, response, sequence_equal, baseline: { attempt: b.attempt, turn: b.turn, attempt_kind: b.attempt_kind, path: b.path }, candidate: { attempt: c.attempt, turn: c.turn, attempt_kind: c.attempt_kind, path: c.path } };
      });
      // Re-assert against the request-correlated completion record. A whole-file
      // token scan cannot prove which request produced the closeout: another
      // request or line may carry the same token.
      const completionRecords = (root) => {
        const text = String(json(join(root, 'rcc-diagnostics.json')).stdout ?? '').replace(/\x1b\[[0-9;]*m/g, '');
        return text.split(/\r?\n/).flatMap((line) => {
          const match = line.match(/req=(\S+) event=completed\b.*?\bfinish_reason=(.*?) elapsedMs=/);
          return match ? [{ request_id: match[1], reason: match[2], line }] : [];
        });
      };
      const baselineRecords = completionRecords(left);
      const candidateRecords = completionRecords(right);
      result.console_records = {
        baseline: baselineRecords.map((record) => ({ request_id: record.request_id, reason: record.reason })),
        candidate: candidateRecords.map((record) => ({ request_id: record.request_id, reason: record.reason })),
      };
      if (baselineRecords.length !== 1) result.errors.push(`baseline must record exactly one request-correlated completion (got ${baselineRecords.length})`);
      if (candidateRecords.length !== 1) result.errors.push(`candidate must record exactly one request-correlated completion (got ${candidateRecords.length})`);
      const explicitReasonCase = id.includes('explicit-reason');
      const expectedBaselineReason = explicitReasonCase ? reason : 'unreported';
      if (baselineRecords[0] && baselineRecords[0].reason !== expectedBaselineReason) result.errors.push(`baseline completion reason ${JSON.stringify(baselineRecords[0].reason)} != ${expectedBaselineReason}`);
      if (candidateRecords[0] && candidateRecords[0].reason !== reason) result.errors.push(`candidate completion reason ${JSON.stringify(candidateRecords[0].reason)} != ${reason}`);
      if (explicitReasonCase && baselineRecords[0] && candidateRecords[0] && baselineRecords[0].reason !== candidateRecords[0].reason) result.errors.push('explicit completion reason differs between baseline and candidate');
      for (const [side, root, records] of [['baseline', left, baselineRecords], ['candidate', right, candidateRecords]]) {
        const evidence = json(join(root, 'execution-mode-evidence.json'));
        const turns = evidence.turns ?? [];
        if (turns.length !== files.length || turns.some((turn) => turn.gap || !turn.request_id || turn.event_type !== 'request.completed' || turn.execution_mode !== 'direct')) {
          result.errors.push(`${side} captured turn correlation missing or incomplete`);
        }
        for (const turn of turns) {
          if (records.filter((record) => record.request_id === turn.request_id).length !== 1) result.errors.push(`${side} captured request ${turn.request_id} must have exactly one completion`);
        }
        const text = String(json(join(root, 'rcc-diagnostics.json')).stdout ?? '').replace(/\x1b\[[0-9;]*m/g, '');
        for (const record of records) {
          const correlated = turns.some((turn) => turn.request_id === record.request_id)
            && text.includes(`req=${record.request_id} event=route_selected`)
            && record.line.includes(`[sessionID:rcc-session:request:${record.request_id}]`);
          if (!correlated) result.errors.push(`${side} completion ${record.request_id} is not correlated to its request`);
        }
      }
      result.execution_mode = cr.cases?.[0]?.execution_mode;
    } catch (error) { result.errors.push(error.stack ?? error.message); }
    result.status = result.errors.length ? 'UNVERIFIED' : 'PASS';
    results.push(result);
  }
  return { status: results.every((r) => r.status === 'PASS') ? 'PASS' : 'UNVERIFIED', boundary: 'HTTP entity-body bytes; raw and comment-only keepalive-removed SSE results are separate', cases: results };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2], process.argv[3 + i * 2]]));
  const result = compare(args['--baseline-evidence'], args['--candidate-evidence']);
  writeFileSync(args['--output'], JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
