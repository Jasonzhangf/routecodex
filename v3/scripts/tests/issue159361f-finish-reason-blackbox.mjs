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
export const twoTurnCases = [
  {
    id: 'responses-to-responses-sse-dsml-harvest-no-reason',
    candidateReasons: ['tool_calls', 'stop'],
    baselineReasons: ['unreported', 'unreported'],
  },
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
function clientSseText(capture) {
  // Client SSE semantic checks (declarations, references, harvested call IDs)
  // must read the same wire bytes as the byte comparison, never the decoded
  // convenience field, so a raw-only mutation cannot escape validation.
  return body(capture?.client_response?.bodyBytesBase64).toString('latin1');
}
function captureRequestBytes(capture) {
  // Provider-bound comparison and pairing must use the bytes the mock received
  // before any UTF-8 decode, so malformed byte differences stay significant. A
  // missing pre-decode capture fails closed and is never rebuilt from the
  // decoded convenience field.
  if (!capture || typeof capture.raw_body_base64 !== 'string' || !capture.raw_body_base64.length) {
    throw new Error('provider request pre-decode bytes missing for a compared business attempt');
  }
  return Buffer.from(capture.raw_body_base64, 'base64');
}
export function withoutKeepalives(bytes) {
  // Remove only complete comment-only keepalive frames, using the same SSE
  // dispatch delimiters (LF, CRLF, bare CR) as sseEvents. Every frame that
  // carries a data field keeps its full extent, including its dispatch
  // delimiter, so a business event can never be silently dropped.
  const source = bytes.toString('latin1');
  const parts = source.split(/(\r\n|\n|\r)/);
  const frames = [];
  let raw = '';
  let hasData = false;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    const separator = parts[index + 1] ?? '';
    if (line === '') {
      if (separator) {
        const logical = raw.split(/\r\n|\n|\r/).filter(Boolean);
        frames.push({ raw: raw + separator, dispatched: true, hasData, commentOnly: logical.every((entry) => entry.startsWith(':')) });
        raw = '';
        hasData = false;
      }
      continue;
    }
    if (!line.startsWith(':')) {
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      if (field === 'data') hasData = true;
    }
    raw += line + separator;
  }
  if (raw) frames.push({ raw, dispatched: false, hasData, commentOnly: false });
  const kept = frames.filter((frame) => !(frame.dispatched && frame.commentOnly)).map((frame) => frame.raw).join('');
  return Buffer.from(kept, 'latin1');
}
function harvestedProcessComponent(text) {
  // Derive the run process component from the dispatched native call ID, never
  // from a raw regex: an SSE comment must not become a process-ID witness.
  const ids = callIds(String(text));
  if (ids.length !== 1) return null;
  return ids[0].match(/\bcall_dsml_(\d+)_\d+\b/)?.[1] ?? null;
}
// Only exact Responses streaming events that define an item reference may
// carry a normalized item_id. Enumerating each family with its real suffixes
// keeps undefined events such as response.output_text.added byte-significant.
const ITEM_ID_EVENT_TYPES = new Set([
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.refusal.delta',
  'response.refusal.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
]);
const CALL_ID_EVENT_TYPES = new Set([
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
]);
// A call_id only exists on call-bearing items; a message or reasoning item
// must not gain one through normalization.
const CALL_BEARING_ITEM_TYPES = new Set(['function_call', 'custom_tool_call']);
const REQUEST_CALL_ID_ITEM_TYPES = new Set([
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
]);
function nodeAt(root, path) {
  let node = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}
function allowedProcessIdPath(path, context) {
  const last = path[path.length - 1];
  if (context.kind === 'sse') {
    const event = context.event;
    const eventType = event?.type;
    if (typeof eventType !== 'string') return false;
    if (path.length === 1 && last === 'item_id') return ITEM_ID_EVENT_TYPES.has(eventType);
    if (path.length === 1 && last === 'call_id') return CALL_ID_EVENT_TYPES.has(eventType);
    if (path.length === 2 && path[0] === 'item'
      && (eventType === 'response.output_item.added' || eventType === 'response.output_item.done')) {
      if (last === 'id') return true;
      if (last === 'call_id') return CALL_BEARING_ITEM_TYPES.has(nodeAt(event, ['item'])?.type);
    }
    if (path.length === 4 && path[0] === 'response' && path[1] === 'output'
      && typeof path[2] === 'number' && eventType === 'response.completed') {
      if (last === 'id') return true;
      if (last === 'call_id') return CALL_BEARING_ITEM_TYPES.has(nodeAt(event, ['response', 'output', path[2]])?.type);
    }
    return false;
  }
  if (context.kind !== 'request') return false;
  if (!(path.length === 3 && path[0] === 'input' && typeof path[1] === 'number' && path[2] === 'call_id')) return false;
  const itemType = nodeAt(context.root, ['input', path[1]])?.type;
  return REQUEST_CALL_ID_ITEM_TYPES.has(itemType);
}
function jsonStringValues(raw) {
  const values = [];
  let duplicateKeys = false;
  let index = 0;
  const skipWhitespace = () => {
    while (index < raw.length && /\s/.test(raw[index])) index++;
  };
  const parseString = () => {
    const start = index++;
    let escaped = false;
    while (index < raw.length) {
      const char = raw[index++];
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        break;
      }
    }
    return { start, end: index, value: JSON.parse(raw.slice(start, index)) };
  };
  const parseValue = (path) => {
    skipWhitespace();
    if (index >= raw.length) return;
    const char = raw[index];
    if (char === '"') {
      values.push({ ...parseString(), path });
      return;
    }
    if (char === '{') {
      index++;
      skipWhitespace();
      if (raw[index] === '}') {
        index++;
        return;
      }
      const seenKeys = new Set();
      while (index < raw.length) {
        skipWhitespace();
        const key = parseString();
        if (seenKeys.has(key.value)) duplicateKeys = true;
        seenKeys.add(key.value);
        skipWhitespace();
        if (raw[index] !== ':') return;
        index++;
        parseValue(path.concat([key.value]));
        skipWhitespace();
        if (raw[index] === ',') {
          index++;
          continue;
        }
        if (raw[index] === '}') index++;
        return;
      }
      return;
    }
    if (char === '[') {
      index++;
      skipWhitespace();
      if (raw[index] === ']') {
        index++;
        return;
      }
      let itemIndex = 0;
      while (index < raw.length) {
        parseValue(path.concat([itemIndex]));
        itemIndex++;
        skipWhitespace();
        if (raw[index] === ',') {
          index++;
          continue;
        }
        if (raw[index] === ']') index++;
        return;
      }
      return;
    }
    while (index < raw.length && !',]} \t\r\n'.includes(raw[index])) index++;
  };
  parseValue([]);
  return { values, duplicateKeys };
}
function jsonProcessIdSpans(raw, processComponent, context) {
  if (!processComponent) return [];
  const { values, duplicateKeys } = jsonStringValues(raw);
  // An ambiguous duplicate field must stay byte-significant, so skip all
  // normalization for this payload and let the byte comparison decide.
  if (duplicateKeys) return [];
  const pattern = new RegExp('^(call|fc|msg)_dsml_' + processComponent + '_(\\d+)$');
  const spans = [];
  for (const { start, end, value, path } of values) {
    if (!allowedProcessIdPath(path, context)) continue;
    const match = typeof value === 'string' && pattern.exec(value);
    if (!match) continue;
    // Keep the literal prefix and ordinal bytes. Only the measured process
    // digit span can differ between two independent runs.
    const rawValue = raw.slice(start + 1, end - 1);
    const rawMatch = /^(call|fc|msg)_dsml_(\d+)_(\d+)$/.exec(rawValue);
    if (!rawMatch || rawMatch[1] !== match[1] || rawMatch[2] !== processComponent || rawMatch[3] !== match[2]) continue;
    const processOffset = rawMatch[1].length + 6;
    spans.push({
      start: start + 1,
      processStart: start + 1 + processOffset,
      processEnd: start + 1 + processOffset + rawMatch[2].length,
      end: end - 1,
    });
  }
  return spans;
}
// Dispatch-aware SSE reader shared by span selection and reference validation.
// Events are separated by blank lines and a final event without a terminating
// blank line is not dispatched by the client, so it can neither declare an item
// nor expose a normalized identity. Consecutive data lines of one event are
// joined with "\n" per the SSE spec; a multi-line event stays byte-significant.
// Every data line keeps its source byte offset so spans map back exactly.
function sseEvents(text) {
  const source = String(text);
  const parts = source.split(/(\r\n|\n|\r)/);
  const events = [];
  let current = { dataLines: [], eventType: null };
  let offset = 0;
  const dispatch = (terminated) => {
    if (current.dataLines.length || current.eventType) {
      events.push({ dataLines: current.dataLines.slice(), eventType: current.eventType, terminated });
    }
    current = { dataLines: [], eventType: null };
  };
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    const separator = parts[index + 1] ?? '';
    const lineStart = offset;
    offset += line.length + separator.length;
    if (line === '') {
      // A real blank line carries a terminator; a trailing empty segment after
      // the final newline has none and must not dispatch the pending event.
      if (separator) dispatch(true);
      continue;
    }
    let content = line;
    let bom = 0;
    // SSE ignores one leading UTF-8 BOM for field recognition. The bytes stay in
    // the source; only the recognised field name shifts by the BOM length.
    if (content.charCodeAt(0) === 0xFEFF) { content = content.slice(1); bom = 1; }
    else if (content.startsWith('\u00EF\u00BB\u00BF')) { content = content.slice(3); bom = 3; }
    if (content.startsWith(':')) continue;
    const match = content.match(/^([^:]*):( ?)(.*)$/s);
    if (!match) {
      // SSE: a line with no colon is a field name with an empty value. A bare
      // `data` line therefore adds a second data field, keeping the event
      // byte-significant for both span selection and reference validation.
      if (content === 'data') current.dataLines.push({ value: '', lineStart, prefixLength: bom + content.length });
      continue;
    }
    if (match[1] === 'data') {
      current.dataLines.push({ value: match[3], lineStart, prefixLength: bom + 5 + match[2].length });
    } else if (match[1] === 'event') {
      current.eventType = match[3];
    }
  }
  dispatch(false);
  return events.filter((event) => event.dataLines.length > 0);
}
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
function processIdSpans(text, processComponent) {
  const source = String(text);
  const events = sseEvents(source);
  if (!events.length) {
    return jsonProcessIdSpans(source, processComponent, { kind: 'request', root: safeJsonParse(source) });
  }
  const spans = [];
  for (const event of events) {
    if (!event.terminated) continue;
    if (event.dataLines.length !== 1) continue;
    const line = event.dataLines[0];
    const parsed = safeJsonParse(line.value);
    if (parsed === undefined) continue;
    for (const span of jsonProcessIdSpans(line.value, processComponent, { kind: 'sse', event: parsed })) {
      spans.push({
        start: line.lineStart + line.prefixLength + span.start,
        processStart: line.lineStart + line.prefixLength + span.processStart,
        processEnd: line.lineStart + line.prefixLength + span.processEnd,
        end: line.lineStart + line.prefixLength + span.end,
      });
    }
  }
  return spans;
}
function processSegments(text, processComponent) {
  const buffer = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
  if (!processComponent) {
    return { segments: [{ type: 'raw', bytes: buffer }], replacements: 0, process_component: null };
  }
  const source = buffer.toString('latin1');
  const spans = processIdSpans(source, processComponent);
  const segments = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) segments.push({ type: 'raw', bytes: Buffer.from(source.slice(cursor, span.start), 'latin1') });
    if (span.processStart > span.start) segments.push({ type: 'raw', bytes: Buffer.from(source.slice(span.start, span.processStart), 'latin1') });
    segments.push({ type: 'process' });
    cursor = span.processEnd;
  }
  if (cursor < source.length) segments.push({ type: 'raw', bytes: Buffer.from(source.slice(cursor), 'latin1') });
  return { segments, replacements: spans.length, process_component: processComponent };
}
function processSegmentsEqual(left, right) {
  if (left.segments.length !== right.segments.length) return false;
  return left.segments.every((segment, index) => {
    const other = right.segments[index];
    if (segment.type !== other.type) return false;
    return segment.type === 'raw' ? segment.bytes.equals(other.bytes) : true;
  });
}
function unresolvedClientItemReferences(text) {
  const parsed = [];
  for (const event of sseEvents(String(text))) {
    if (!event.terminated) continue;
    if (event.dataLines.length !== 1) continue;
    const payload = event.dataLines[0].value;
    const parsedEvent = safeJsonParse(payload);
    if (parsedEvent !== undefined) parsed.push({ event: parsedEvent, payload });
  }
  const declared = new Set();
  for (const { event } of parsed) {
    if ((event?.type === 'response.output_item.added' || event?.type === 'response.output_item.done') && event?.item?.id) {
      declared.add(event.item.id);
    }
    if (event?.type === 'response.completed') {
      for (const item of event?.response?.output ?? []) {
        if (item?.id) declared.add(item.id);
      }
    }
  }
  const unresolved = [];
  for (const { event, payload } of parsed) {
    const { values, duplicateKeys } = jsonStringValues(payload);
    // Validate every raw field occurrence, not the last-wins JSON.parse view,
    // so a duplicated or reordered item_id cannot hide an undeclared value.
    for (const { value, path } of values) {
      if (!(path.length === 1 && path[0] === 'item_id')) continue;
      if (typeof value !== 'string' || !value.includes('_dsml_')) continue;
      if (!declared.has(value)) unresolved.push({ type: event?.type, item_id: value });
    }
    if (duplicateKeys) unresolved.push({ type: event?.type, duplicate_fields: true });
  }
  return unresolved;
}
function callIds(text) {
  // Native call IDs come from dispatched protocol events only. Parse terminated
  // single-data-line events and read item.call_id; SSE comments can never witness.
  const ids = new Set();
  for (const event of sseEvents(String(text))) {
    if (!event.terminated) continue;
    if (event.dataLines.length !== 1) continue;
    const parsed = safeJsonParse(event.dataLines[0].value);
    if (!parsed || typeof parsed !== 'object') continue;
    const consider = (item) => {
      if (item && CALL_BEARING_ITEM_TYPES.has(item.type) && typeof item.call_id === 'string') ids.add(item.call_id);
    };
    if ((parsed.type === 'response.output_item.added' || parsed.type === 'response.output_item.done') && parsed.item) consider(parsed.item);
    if (parsed.type === 'response.completed') for (const item of parsed.response?.output ?? []) consider(item);
  }
  return [...ids];
}
export function compare(baseline, candidate) {
  const results = [];
  const definitions = [
    ...cases.map(([id, reason]) => ({ id, candidateReasons: [reason], baselineReasons: [id.includes('explicit-reason') ? reason : 'unreported'] })),
    ...twoTurnCases,
  ];
  for (const definition of definitions) {
    const { id, candidateReasons, baselineReasons } = definition;
    const left = join(baseline, id, id), right = join(candidate, id, id);
    const result = { case_id: id, expected_candidate_reasons: candidateReasons, expected_baseline_reasons: baselineReasons, checks: [], errors: [] };
    try {
      const br = json(join(baseline, id, 'baseline-report.json'));
      const cr = json(join(candidate, id, 'baseline-report.json'));
      result.cleanup = { baseline: br.cleanup, candidate: cr.cleanup };
      if (br.status !== 'passed' || cr.status !== 'passed' || !br.cleanup.complete || !cr.cleanup.complete) result.errors.push('public case or cleanup failed');
      const files = readdirSync(join(left, 'captures')).filter((p) => p.endsWith('-client.json')).sort();
      if (!files.length) throw new Error('missing client capture');
      const twoTurn = candidateReasons.length > 1;
      if (twoTurn && files.length !== 2) result.errors.push(`two-turn case must capture exactly two turns (got ${files.length})`);
      const allowedProcessIds = {};
      if (twoTurn && files.length === 2) {
        for (const [side, root] of [['baseline', left], ['candidate', right]]) {
          const first = json(join(root, 'captures', files[0]));
          const processComponent = harvestedProcessComponent(clientSseText(first));
          allowedProcessIds[side] = processComponent;
          if (!processComponent) result.errors.push(`${side} first client response has no harvested DSML call ID`);
        }
      }
      for (const file of files) {
        const b = json(join(left, 'captures', file)), c = json(join(right, 'captures', file));
        const requestText = String(b.request.body_text), candidateRequestText = String(c.request.body_text);
        for (const [side, capture] of [['baseline', b], ['candidate', c]]) {
          const unresolved = unresolvedClientItemReferences(clientSseText(capture));
          if (unresolved.length) result.errors.push(`${side} client item_id references do not match declared items: ${JSON.stringify(unresolved)}`);
        }
        const processRequest = processSegments(Buffer.from(requestText, 'utf8'), allowedProcessIds.baseline);
        const processCandidateRequest = processSegments(Buffer.from(candidateRequestText, 'utf8'), allowedProcessIds.candidate);
        const request = twoTurn
          ? { equal: processSegmentsEqual(processRequest, processCandidateRequest), baseline_replacements: processRequest.replacements, candidate_replacements: processCandidateRequest.replacements }
          : difference(Buffer.from(requestText), Buffer.from(candidateRequestText));
        const bb = body(b.client_response.bodyBytesBase64), cb = body(c.client_response.bodyBytesBase64);
        const raw = difference(bb, cb);
        const businessText = (bytes) => id.includes('-sse') ? withoutKeepalives(bytes) : bytes;
        const processClient = processSegments(businessText(bb), allowedProcessIds.baseline);
        const processCandidateClient = processSegments(businessText(cb), allowedProcessIds.candidate);
        const business = id.includes('-sse')
          ? twoTurn
            ? { equal: processSegmentsEqual(processClient, processCandidateClient), baseline_replacements: processClient.replacements, candidate_replacements: processCandidateClient.replacements }
            : difference(withoutKeepalives(bb), withoutKeepalives(cb))
          : twoTurn
            ? { equal: processSegmentsEqual(processClient, processCandidateClient), baseline_replacements: processClient.replacements, candidate_replacements: processCandidateClient.replacements }
            : difference(bb, cb);
        const completion = ['status', 'response_ended', 'complete', 'closed', 'aborted', 'error'].every((k) => JSON.stringify(b.client_response[k]) === JSON.stringify(c.client_response[k]));
        const normalization = twoTurn ? { baseline_replacements: processRequest.replacements + processClient.replacements, candidate_replacements: processCandidateRequest.replacements + processCandidateClient.replacements, baseline_process_component: allowedProcessIds.baseline, candidate_process_component: allowedProcessIds.candidate, policy: 'only declared protocol call_id/item_id/item.id/output[].id fields carrying this run\'s harvested DSML process component are compared as identity segments' } : null;
        result.checks.push({ file, request, raw_client_body: raw, comment_only_keepalive_removed: business, completion, process_id_normalization: normalization });
        if (!request.equal || !business.equal || !completion) result.errors.push(`client/input/completion bytes differ: ${file}`);
        if (twoTurn && (!normalization.baseline_replacements || !normalization.candidate_replacements)) result.errors.push(`process-generated DSML IDs were not present to normalize: ${file}`);
      }
      const turnOneCaptures = {};
      if (twoTurn && files.length === 2) {
        const baselineTurnOne = json(join(left, 'captures', files[0])), baselineTurnTwo = json(join(left, 'captures', files[1]));
        const candidateTurnOne = json(join(right, 'captures', files[0])), candidateTurnTwo = json(join(right, 'captures', files[1]));
        for (const [side, first, second] of [['baseline', baselineTurnOne, baselineTurnTwo], ['candidate', candidateTurnOne, candidateTurnTwo]]) {
          const harvested = callIds(clientSseText(first));
          const followupBody = JSON.parse(String(second.request.body_text));
          const callItems = (followupBody.input ?? []).filter((item) => item.type === 'function_call');
          const resultItems = (followupBody.input ?? []).filter((item) => item.type === 'function_call_output');
          const paired = harvested.length === 1
            && callItems.length === 1
            && resultItems.length === 1
            && callItems[0].call_id === harvested[0]
            && resultItems[0].call_id === harvested[0]
            && resultItems[0].output === 'ping';
          result.call_id_pairing = { ...(result.call_id_pairing ?? {}), [side]: { harvested_call_ids: harvested, paired } };
          if (!paired) result.errors.push(`${side} harvested call ID does not pair with its follow-up tool result`);
          turnOneCaptures[side] = first;
        }
      }
      const bp = json(join(left, 'provider-captures.json')), cp = json(join(right, 'provider-captures.json'));
      const business = (items) => items.filter((p) => !['startup', 'probe'].includes(p.attempt_kind));
      const ba = business(bp), ca = business(cp);
      result.attempts = { baseline: ba.length, candidate: ca.length, baseline_probes: bp.length - ba.length, candidate_probes: cp.length - ca.length };
      if (!ba.length || ba.length !== ca.length) result.errors.push('business attempt count differs or absent');
      if (twoTurn) {
        const providerPaired = (side, captures, harvested) => {
          const followup = captures.find((p) => !['startup', 'probe'].includes(p.attempt_kind) && p.turn === 1);
          if (!followup) return { paired: false, error: `${side} provider follow-up capture is missing` };
          const followupBody = JSON.parse(captureRequestBytes(followup).toString('utf8'));
          const callItems = (followupBody.input ?? []).filter((item) => item.type === 'function_call');
          const resultItems = (followupBody.input ?? []).filter((item) => item.type === 'function_call_output');
          const paired = harvested.length === 1
            && callItems.length === 1
            && resultItems.length === 1
            && callItems[0].call_id === harvested[0]
            && resultItems[0].call_id === harvested[0];
          return { paired, error: paired ? null : `${side} provider-bound follow-up call/result IDs ${JSON.stringify({ call: callItems[0]?.call_id, result: resultItems[0]?.call_id })} do not carry the exact harvested call ID ${JSON.stringify(harvested[0] ?? null)}` };
        };
        result.provider_call_id_pairing = {};
        for (const [side, captures] of [['baseline', ba], ['candidate', ca]]) {
          const turnOne = turnOneCaptures[side];
          const harvested = turnOne ? callIds(clientSseText(turnOne)) : [];
          const check = providerPaired(side, captures, harvested);
          result.provider_call_id_pairing[side] = check;
          if (!check.paired) result.errors.push(check.error);
        }
      }
      result.provider = ba.map((b, i) => {
        const c = ca[i];
        if (!c) return { missing: true };
        const baselineRequestBytes = captureRequestBytes(b), candidateRequestBytes = captureRequestBytes(c);
        const processBaselineRequest = processSegments(baselineRequestBytes, allowedProcessIds.baseline);
        const processCandidateRequest = processSegments(candidateRequestBytes, allowedProcessIds.candidate);
        const request = twoTurn
          ? { equal: processSegmentsEqual(processBaselineRequest, processCandidateRequest), baseline_replacements: processBaselineRequest.replacements, candidate_replacements: processCandidateRequest.replacements }
          : difference(baselineRequestBytes, candidateRequestBytes);
        const response = difference(body(b.response_wire?.bytes_base64), body(c.response_wire?.bytes_base64));
        const sequence_equal = ['attempt', 'turn', 'attempt_kind', 'path'].every((k) => b[k] === c[k]);
        if (!request.equal || !response.equal || !sequence_equal) result.errors.push(`provider request/wire/sequence differs: ${i}`);
        const request_process_id_normalization = twoTurn
          ? { baseline_replacements: processBaselineRequest.replacements, candidate_replacements: processCandidateRequest.replacements, baseline_process_component: allowedProcessIds.baseline, candidate_process_component: allowedProcessIds.candidate, policy: 'only declared protocol call_id/item_id/item.id/output[].id fields carrying this run\'s harvested DSML process component are compared as identity segments; provider response bytes remain exact' }
          : null;
        if (twoTurn && !baselineRequestBytes.equals(candidateRequestBytes) && (!processBaselineRequest.replacements || !processCandidateRequest.replacements)) {
          result.errors.push(`provider request process-generated DSML IDs were not present to normalize: ${i}`);
        }
        return { request, response, sequence_equal, request_process_id_normalization, baseline: { attempt: b.attempt, turn: b.turn, attempt_kind: b.attempt_kind, path: b.path }, candidate: { attempt: c.attempt, turn: c.turn, attempt_kind: c.attempt_kind, path: c.path } };
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
      if (baselineRecords.length !== baselineReasons.length) result.errors.push(`baseline must record exactly ${baselineReasons.length} request-correlated completion(s) (got ${baselineRecords.length})`);
      if (candidateRecords.length !== candidateReasons.length) result.errors.push(`candidate must record exactly ${candidateReasons.length} request-correlated completion(s) (got ${candidateRecords.length})`);
      for (const [side, root, records] of [['baseline', left, baselineRecords], ['candidate', right, candidateRecords]]) {
        const evidence = json(join(root, 'execution-mode-evidence.json'));
        const turns = evidence.turns ?? [];
        if (turns.length !== files.length || turns.some((turn) => turn.gap || !turn.request_id || turn.event_type !== 'request.completed' || turn.execution_mode !== 'direct')) {
          result.errors.push(`${side} captured turn correlation missing or incomplete`);
        }
        const expectedReasons = side === 'baseline' ? baselineReasons : candidateReasons;
        for (const [index, turn] of turns.entries()) {
          const matches = records.filter((record) => record.request_id === turn.request_id);
          if (matches.length !== 1) result.errors.push(`${side} captured request ${turn.request_id} must have exactly one completion`);
          if (matches.length === 1 && matches[0].reason !== expectedReasons[index]) result.errors.push(`${side} turn ${index + 1} reason ${JSON.stringify(matches[0].reason)} != ${expectedReasons[index]}`);
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
