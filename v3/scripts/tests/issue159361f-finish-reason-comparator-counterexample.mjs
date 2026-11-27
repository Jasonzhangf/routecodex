#!/usr/bin/env node
// Comparator counterexamples: exact provider-bound call pairing must reject a
// changed result ID, and client-SSE process normalization must reject a broken
// within-run item reference. Both mutations use temporary copies.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compare, withoutKeepalives } from './issue159361f-finish-reason-blackbox.mjs';

const evidenceRoot = process.argv[2];
if (!evidenceRoot) throw new Error('usage: issue159361f-finish-reason-comparator-counterexample.mjs EVIDENCE_ROOT');
const sourceBaseline = join(evidenceRoot, 'baseline');
const sourceCandidate = join(evidenceRoot, 'candidate');
const caseId = 'responses-to-responses-sse-dsml-harvest-no-reason';

function withCandidateCopy(mutate) {
  const temp = mkdtempSync(join(tmpdir(), 'issue159361f-counterexample-'));
  try {
    cpSync(sourceBaseline, join(temp, 'baseline'), { recursive: true });
    cpSync(sourceCandidate, join(temp, 'candidate'), { recursive: true });
    const mutation = mutate(join(temp, 'candidate', caseId, caseId));
    const receipt = compare(join(temp, 'baseline'), join(temp, 'candidate'));
    return { receipt, caseReceipt: receipt.cases.find((entry) => entry.case_id === caseId), mutation };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
function withBothCopies(mutate) {
  const temp = mkdtempSync(join(tmpdir(), 'issue159361f-counterexample-'));
  try {
    cpSync(sourceBaseline, join(temp, 'baseline'), { recursive: true });
    cpSync(sourceCandidate, join(temp, 'candidate'), { recursive: true });
    const mutation = mutate(
      join(temp, 'baseline', caseId, caseId),
      join(temp, 'candidate', caseId, caseId),
    );
    const receipt = compare(join(temp, 'baseline'), join(temp, 'candidate'));
    return { receipt, caseReceipt: receipt.cases.find((entry) => entry.case_id === caseId), mutation };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
function setClientBody(capture, bodyText) {
  capture.client_response.bodyText = bodyText;
  capture.client_response.bodyBytesBase64 = Buffer.from(bodyText, 'utf8').toString('base64');
}
function setProviderRequestText(capture, text) {
  const bytes = Buffer.from(text, 'utf8');
  capture.raw_body_base64 = bytes.toString('base64');
  capture.raw_body = bytes.toString('utf8');
}
function setClientBytesOnly(capture, buffer) {
  capture.client_response.bodyBytesBase64 = buffer.toString('base64');
}
function withMetadataField(fieldPath, makeValue) {
  return withBothCopies((baselineDir, candidateDir) => {
    const values = {};
    for (const [side, caseDir] of [['baseline', baselineDir], ['candidate', candidateDir]]) {
      const capturesPath = join(caseDir, 'captures', `${caseId}-turn-1-client.json`);
      const capture = JSON.parse(readFileSync(capturesPath, 'utf8'));
      const bodyText = String(capture.client_response.bodyText);
      const callId = bodyText.match(/\bcall_dsml_\d+_\d+\b/)?.[0];
      if (!callId) throw new Error(`${side} client SSE call ID not found`);
      const processComponent = callId.match(/^call_dsml_(\d+)_/)[1];
      const value = makeValue(processComponent);
      const mutatedBody = bodyText.replace(/^data: (.*)$/m, (_line, payload) => {
        const event = JSON.parse(payload);
        event.metadata = {};
        let target = event.metadata;
        for (let index = 0; index < fieldPath.length - 1; index++) {
          const segment = fieldPath[index];
          target[segment] = typeof fieldPath[index + 1] === 'number' ? [] : {};
          target = target[segment];
        }
        target[fieldPath[fieldPath.length - 1]] = value;
        return 'data: ' + JSON.stringify(event);
      });
      if (mutatedBody === bodyText) throw new Error(`${side} nested metadata mutation did not apply`);
      setClientBody(capture, mutatedBody);
      writeFileSync(capturesPath, JSON.stringify(capture, null, 2) + '\n');
      values[side] = value;
    }
    return values;
  });
}
function withCreatedEventMutation(mutate) {
  return withBothCopies((baselineDir, candidateDir) => {
    const values = {};
    for (const [side, caseDir] of [['baseline', baselineDir], ['candidate', candidateDir]]) {
      const capturesPath = join(caseDir, 'captures', caseId + '-turn-1-client.json');
      const capture = JSON.parse(readFileSync(capturesPath, 'utf8'));
      const bodyText = String(capture.client_response.bodyText);
      const callId = bodyText.match(/\bcall_dsml_\d+_\d+\b/)?.[0];
      if (!callId) throw new Error(side + ' client SSE call ID not found');
      const processComponent = callId.match(/^call_dsml_(\d+)_/)[1];
      const value = 'fc_dsml_' + processComponent + '_91';
      const mutatedBody = bodyText.replace(/^data: (.*)$/m, (_line, payload) => {
        const event = JSON.parse(payload);
        mutate(event, value);
        return 'data: ' + JSON.stringify(event);
      });
      if (mutatedBody === bodyText) throw new Error(side + ' created-event mutation did not apply');
      setClientBody(capture, mutatedBody);
      writeFileSync(capturesPath, JSON.stringify(capture, null, 2) + '\n');
      values[side] = value;
    }
    return values;
  });
}

const results = {};

results.provider_bound_result_id = withCandidateCopy((caseDir) => {
  const capturesPath = join(caseDir, 'provider-captures.json');
  const captures = JSON.parse(readFileSync(capturesPath, 'utf8'));
  const followup = captures.find((p) => !['startup', 'probe'].includes(p.attempt_kind) && p.turn === 1);
  if (!followup) throw new Error('provider follow-up capture not found');
  const originalCallId = String(followup.raw_body).match(/"call_id":"(call_dsml_\d+_\d+)","output"/)?.[1];
  if (!originalCallId) throw new Error('provider-bound function_call_output ID not found');
  const processComponent = originalCallId.match(/^call_dsml_(\d+)_/)[1];
  const replacementCallId = originalCallId.replace(`call_dsml_${processComponent}_`, 'call_dsml_999999_');
  setProviderRequestText(followup, String(followup.raw_body).replace(`"call_id":"${originalCallId}","output"`, `"call_id":"${replacementCallId}","output"`));
  writeFileSync(capturesPath, JSON.stringify(captures, null, 2) + '\n');
  return { original: originalCallId, replacement: replacementCallId };
});

results.client_item_reference = withCandidateCopy((caseDir) => {
  const capturesPath = join(caseDir, 'captures', `${caseId}-turn-1-client.json`);
  const capture = JSON.parse(readFileSync(capturesPath, 'utf8'));
  const bodyText = String(capture.client_response.bodyText);
  const callId = bodyText.match(/\bcall_dsml_\d+_\d+\b/)?.[0];
  const itemId = bodyText.match(/"item_id":"(fc_dsml_\d+_\d+)"/)?.[1];
  if (!callId || !itemId) throw new Error('client SSE call/item ID not found');
  const processComponent = callId.match(/^call_dsml_(\d+)_/)[1];
  const replacementItemId = itemId.replace(`fc_dsml_${processComponent}_`, 'fc_dsml_999999_');
  const needle = `"item_id":"${itemId}"`;
  const mutatedBody = bodyText.replace(needle, `"item_id":"${replacementItemId}"`);
  if (mutatedBody === bodyText) throw new Error('client SSE item_id mutation did not apply');
  setClientBody(capture, mutatedBody);
  writeFileSync(capturesPath, JSON.stringify(capture, null, 2) + '\n');
  return { original: itemId, replacement: replacementItemId };
});

results.client_item_reference_literal_token = withCandidateCopy((caseDir) => {
  const capturesPath = join(caseDir, 'captures', `${caseId}-turn-1-client.json`);
  const capture = JSON.parse(readFileSync(capturesPath, 'utf8'));
  const bodyText = String(capture.client_response.bodyText);
  const callId = bodyText.match(/\bcall_dsml_\d+_\d+\b/)?.[0];
  const itemId = bodyText.match(/"item_id":"(fc_dsml_\d+_\d+)"/)?.[1];
  if (!callId || !itemId) throw new Error('client SSE call/item ID not found');
  const processComponent = callId.match(/^call_dsml_(\d+)_/)[1];
  const replacementItemId = itemId.replace(`fc_dsml_${processComponent}_`, 'fc_dsml_PROCESS_');
  const needle = `"item_id":"${itemId}"`;
  const mutatedBody = bodyText.replace(needle, `"item_id":"${replacementItemId}"`);
  if (mutatedBody === bodyText) throw new Error('literal-token client SSE item_id mutation did not apply');
  setClientBody(capture, mutatedBody);
  writeFileSync(capturesPath, JSON.stringify(capture, null, 2) + '\n');
  return { original: itemId, replacement: replacementItemId };
});

results.client_metadata_id = withMetadataField(['id'], (component) => 'fc_dsml_' + component + '_91');
results.client_metadata_call_id = withMetadataField(['call_id'], (component) => 'call_dsml_' + component + '_91');
results.client_metadata_item_id = withMetadataField(['item', 'id'], (component) => 'fc_dsml_' + component + '_91');
results.client_metadata_output_id = withMetadataField(['output', 0, 'id'], (component) => 'msg_dsml_' + component + '_91');
results.client_item_wire_escape = withCandidateCopy((caseDir) => {
  const capturesPath = join(caseDir, 'captures', caseId + '-turn-1-client.json');
  const capture = JSON.parse(readFileSync(capturesPath, 'utf8'));
  const bodyText = String(capture.client_response.bodyText);
  const itemId = bodyText.match(/"item_id":"(fc_dsml_\d+_\d+)"/)?.[1];
  if (!itemId) throw new Error('client SSE function item ID not found');
  const escapedItemId = itemId.replace(/^f/, '\\u0066');
  const needle = '"item_id":"' + itemId + '"';
  const mutatedBody = bodyText.replace(needle, '"item_id":"' + escapedItemId + '"');
  if (mutatedBody === bodyText) throw new Error('wire-escape item_id mutation did not apply');
  setClientBody(capture, mutatedBody);
  writeFileSync(capturesPath, JSON.stringify(capture, null, 2) + '\n');
  return { original: itemId, replacement: escapedItemId };
});

results.client_created_item_id_extension = withCreatedEventMutation((event, value) => {
  event.item_id = value;
});

results.client_created_item_id_declaration = withBothCopies((baselineDir, candidateDir) => {
  const values = {};
  for (const [side, caseDir] of [['baseline', baselineDir], ['candidate', candidateDir]]) {
    const capturesPath = join(caseDir, 'captures', caseId + '-turn-1-client.json');
    const capture = JSON.parse(readFileSync(capturesPath, 'utf8'));
    const bodyText = String(capture.client_response.bodyText);
    const callId = bodyText.match(/\bcall_dsml_\d+_\d+\b/)?.[0];
    if (!callId) throw new Error(side + ' client SSE call ID not found');
    const processComponent = callId.match(/^call_dsml_(\d+)_/)[1];
    const value = 'fc_dsml_' + processComponent + '_91';
    const originalRef = '"item_id":"fc_dsml_' + processComponent + '_1"';
    const targetRef = '"item_id":"' + value + '"';
    let mutatedBody = bodyText.replace(originalRef, targetRef);
    if (mutatedBody === bodyText) throw new Error(side + ' client item reference mutation did not apply');
    mutatedBody = mutatedBody.replace(/^data: (.*)$/m, (_line, payload) => {
      const event = JSON.parse(payload);
      event.item = { id: value, type: 'function_call' };
      return 'data: ' + JSON.stringify(event);
    });
    setClientBody(capture, mutatedBody);
    writeFileSync(capturesPath, JSON.stringify(capture, null, 2) + '\n');
    values[side] = value;
  }
  return values;
});

results.client_entity_body_bytes = withBothCopies((baselineDir, candidateDir) => {
  const replacements = { baseline: 0x80, candidate: 0x81 };
  for (const [side, caseDir] of [['baseline', baselineDir], ['candidate', candidateDir]]) {
    const capturesPath = join(caseDir, 'captures', caseId + '-turn-1-client.json');
    const capture = JSON.parse(readFileSync(capturesPath, 'utf8'));
    const buffer = Buffer.from(capture.client_response.bodyBytesBase64, 'base64');
    const marker = Buffer.from('"delta":"');
    const offset = buffer.indexOf(marker);
    if (offset < 0) throw new Error(side + ' client delta marker not found');
    buffer[offset + marker.length] = replacements[side];
    capture.client_response.bodyBytesBase64 = buffer.toString('base64');
    writeFileSync(capturesPath, JSON.stringify(capture, null, 2) + '\n');
  }
  return replacements;
});


// fix7-1: an undefined streaming event must not normalize item_id.
results.client_unsupported_event_item_id = withBothCopies((baselineDir, candidateDir) => {
  const values = {};
  for (const [side, caseDir] of [['baseline', baselineDir], ['candidate', candidateDir]]) {
    const capturesPath = join(caseDir, 'captures', caseId + '-turn-1-client.json');
    const capture = JSON.parse(readFileSync(capturesPath, 'utf8'));
    const bodyText = String(capture.client_response.bodyText);
    let mutated = false;
    const mutatedBody = bodyText.replace(/^data: (.*)$/gm, (_line, payload) => {
      const event = JSON.parse(payload);
      if (event.type === 'response.function_call_arguments.delta') {
        event.type = 'response.function_call_arguments.added';
        mutated = true;
      }
      return 'data: ' + JSON.stringify(event);
    });
    if (!mutated) throw new Error(side + ' unsupported-event mutation did not apply');
    setClientBody(capture, mutatedBody);
    writeFileSync(capturesPath, JSON.stringify(capture, null, 2) + '\n');
    values[side] = 'response.function_call_arguments.added';
  }
  return values;
});

// fix7-1: a message item must not accept a protocol call_id.
results.client_message_item_call_id = withBothCopies((baselineDir, candidateDir) => {
  for (const [side, caseDir] of [['baseline', baselineDir], ['candidate', candidateDir]]) {
    const capturesPath = join(caseDir, 'captures', caseId + '-turn-1-client.json');
    const capture = JSON.parse(readFileSync(capturesPath, 'utf8'));
    const bodyText = String(capture.client_response.bodyText);
    const callId = bodyText.match(/\bcall_dsml_\d+_\d+\b/)?.[0];
    if (!callId) throw new Error(side + ' client SSE call ID not found');
    let mutated = false;
    const mutatedBody = bodyText.replace(/^data: (.*)$/gm, (_line, payload) => {
      const event = JSON.parse(payload);
      if (!mutated && event.type === 'response.output_item.added' && event.item && event.item.type === 'message') {
        event.item.call_id = callId;
        mutated = true;
      }
      return 'data: ' + JSON.stringify(event);
    });
    if (!mutated) throw new Error(side + ' message item for call_id mutation not found');
    setClientBody(capture, mutatedBody);
    writeFileSync(capturesPath, JSON.stringify(capture, null, 2) + '\n');
  }
  return { injected: 'message item call_id' };
});

// fix7-2: bare-CR framing must not skip reference validation.
results.client_bare_cr_unresolved_reference = withBothCopies((baselineDir, candidateDir) => {
  for (const [side, caseDir] of [['baseline', baselineDir], ['candidate', candidateDir]]) {
    const capturesPath = join(caseDir, 'captures', caseId + '-turn-1-client.json');
    const capture = JSON.parse(readFileSync(capturesPath, 'utf8'));
    const bodyText = String(capture.client_response.bodyText);
    const callId = bodyText.match(/\bcall_dsml_\d+_\d+\b/)?.[0];
    const itemId = bodyText.match(/"item_id":"(fc_dsml_\d+_\d+)"/)?.[1];
    if (!callId || !itemId) throw new Error(side + ' client SSE call/item ID not found');
    const component = callId.match(/^call_dsml_(\d+)_/)[1];
    const undeclared = itemId.replace('fc_dsml_' + component + '_', 'fc_dsml_' + component + '_91');
    let mutated = bodyText.replace('"item_id":"' + itemId + '"', '"item_id":"' + undeclared + '"');
    if (mutated === bodyText) throw new Error(side + ' bare-CR reference mutation did not apply');
    mutated = mutated.replace(/\r\n/g, '\n').replace(/\n/g, '\r');
    setClientBody(capture, mutated);
    writeFileSync(capturesPath, JSON.stringify(capture, null, 2) + '\n');
  }
  return { injected: 'bare CR + undeclared reference' };
});

// fix7-2: duplicate item_id fields must stay byte-significant.
results.client_duplicate_item_id = withBothCopies((baselineDir, candidateDir) => {
  for (const [side, caseDir] of [['baseline', baselineDir], ['candidate', candidateDir]]) {
    const capturesPath = join(caseDir, 'captures', caseId + '-turn-1-client.json');
    const capture = JSON.parse(readFileSync(capturesPath, 'utf8'));
    const bodyText = String(capture.client_response.bodyText);
    const callId = bodyText.match(/\bcall_dsml_\d+_\d+\b/)?.[0];
    const itemId = bodyText.match(/"item_id":"(fc_dsml_\d+_\d+)"/)?.[1];
    if (!callId || !itemId) throw new Error(side + ' client SSE call/item ID not found');
    const component = callId.match(/^call_dsml_(\d+)_/)[1];
    const undeclared = 'fc_dsml_' + component + '_91';
    const needle = '"item_id":"' + itemId + '"';
    const mutated = bodyText.replace(needle, '"item_id":"' + undeclared + '",' + needle);
    if (mutated === bodyText) throw new Error(side + ' duplicate item_id mutation did not apply');
    setClientBody(capture, mutated);
    writeFileSync(capturesPath, JSON.stringify(capture, null, 2) + '\n');
  }
  return { injected: 'duplicate item_id' };
});

// fix7-3: provider-bound request bytes must be compared before text decoding.
results.provider_request_byte_mutation = withBothCopies((baselineDir, candidateDir) => {
  const replacements = { baseline: 0x80, candidate: 0x81 };
  for (const [side, caseDir] of [['baseline', baselineDir], ['candidate', candidateDir]]) {
    const capturesPath = join(caseDir, 'provider-captures.json');
    const captures = JSON.parse(readFileSync(capturesPath, 'utf8'));
    const followup = captures.find((p) => !['startup', 'probe'].includes(p.attempt_kind) && p.turn === 1);
    if (!followup) throw new Error(side + ' provider follow-up capture not found');
    const buffer = Buffer.from(followup.raw_body_base64 ?? Buffer.from(String(followup.raw_body), 'utf8').toString('base64'), 'base64');
    const marker = Buffer.from('"output":"');
    const offset = buffer.indexOf(marker);
    if (offset < 0) throw new Error(side + ' provider request output marker not found');
    buffer[offset + marker.length] = replacements[side];
    followup.raw_body_base64 = buffer.toString('base64');
    followup.raw_body = buffer.toString('utf8');
    writeFileSync(capturesPath, JSON.stringify(captures, null, 2) + '\n');
  }
  return replacements;
});


// fix8-1: an unterminated trailing event must not supply a declaration.
results.client_unterminated_declaration = withBothCopies((baselineDir, candidateDir) => {
  for (const [side, caseDir] of [['baseline', baselineDir], ['candidate', candidateDir]]) {
    const capturesPath = join(caseDir, 'captures', caseId + '-turn-1-client.json');
    const capture = JSON.parse(readFileSync(capturesPath, 'utf8'));
    const bodyText = String(capture.client_response.bodyText);
    const callId = bodyText.match(/\bcall_dsml_\d+_\d+\b/)?.[0];
    const itemId = bodyText.match(/"item_id":"(fc_dsml_\d+_\d+)"/)?.[1];
    if (!callId || !itemId) throw new Error(side + ' client SSE call/item ID not found');
    const component = callId.match(/^call_dsml_(\d+)_/)[1];
    const undeclared = 'fc_dsml_' + component + '_91';
    let mutated = bodyText.replace('"item_id":"' + itemId + '"', '"item_id":"' + undeclared + '"');
    if (mutated === bodyText) throw new Error(side + ' reference change failed');
    const decl = { type: 'response.output_item.done', item: { id: undeclared, type: 'function_call' } };
    // Append after the terminating blank line with only a single trailing newline,
    // so the client never dispatches this declaration.
    mutated = mutated + 'event: response.output_item.done\ndata: ' + JSON.stringify(decl) + '\n';
    setClientBody(capture, mutated);
    writeFileSync(capturesPath, JSON.stringify(capture, null, 2) + '\n');
  }
  return { injected: 'unterminated declaration' };
});

// fix8-1: a multi-line (non-dispatched-JSON) event must stay byte-significant.
results.client_multiline_split_event = withBothCopies((baselineDir, candidateDir) => {
  for (const [side, caseDir] of [['baseline', baselineDir], ['candidate', candidateDir]]) {
    const capturesPath = join(caseDir, 'captures', caseId + '-turn-1-client.json');
    const capture = JSON.parse(readFileSync(capturesPath, 'utf8'));
    const bodyText = String(capture.client_response.bodyText);
    let mutated = false;
    const mutatedBody = bodyText.replace(/^(data: )((\{.*"type":"response\.function_call_arguments\.delta".*\}))$/m, (_line, prefix, json) => {
      mutated = true;
      return prefix + json + '\ndata: not-json-line';
    });
    if (!mutated) throw new Error(side + ' function_call_arguments.delta data line not found');
    setClientBody(capture, mutatedBody);
    writeFileSync(capturesPath, JSON.stringify(capture, null, 2) + '\n');
  }
  return { injected: 'multiline invalid-json event' };
});

// fix8-2: a compared business attempt must carry pre-decode request bytes.
results.provider_capture_missing_bytes = withBothCopies((baselineDir, candidateDir) => {
  for (const [side, caseDir] of [['baseline', baselineDir], ['candidate', candidateDir]]) {
    const capturesPath = join(caseDir, 'provider-captures.json');
    const captures = JSON.parse(readFileSync(capturesPath, 'utf8'));
    const business = captures.filter((p) => !['startup', 'probe'].includes(p.attempt_kind));
    if (!business.length) throw new Error(side + ' no business provider capture');
    for (const p of business) delete p.raw_body_base64;
    writeFileSync(capturesPath, JSON.stringify(captures, null, 2) + '\n');
  }
  return { injected: 'missing raw_body_base64' };
});

// fix8-2: the raw bytes and the decoded convenience field must not disagree.
results.provider_raw_decoded_disagreement = withBothCopies((baselineDir, candidateDir) => {
  for (const [side, caseDir] of [['baseline', baselineDir], ['candidate', candidateDir]]) {
    const capturesPath = join(caseDir, 'provider-captures.json');
    const captures = JSON.parse(readFileSync(capturesPath, 'utf8'));
    const followup = captures.find((p) => !['startup', 'probe'].includes(p.attempt_kind) && p.turn === 1);
    if (!followup) throw new Error(side + ' provider follow-up capture not found');
    const text = Buffer.from(followup.raw_body_base64, 'base64').toString('latin1');
    const original = text.match(/"call_id":"(call_dsml_\d+_0)"/)?.[1];
    if (!original) throw new Error(side + ' provider follow-up call_id not found');
    const replaced = original.replace(/_0$/, '_99');
    const next = text.replace('"call_id":"' + original + '"', '"call_id":"' + replaced + '"');
    followup.raw_body_base64 = Buffer.from(next, 'latin1').toString('base64');
    // raw_body convenience field intentionally left unchanged (disagreement)
    writeFileSync(capturesPath, JSON.stringify(captures, null, 2) + '\n');
  }
  return { injected: 'raw/decoded disagreement' };
});

// fix9-review-1a: a raw-only item_id mutation must be caught by reference
// validation on the same wire bytes the byte comparison uses.
results.client_raw_only_item_id = withBothCopies((baselineDir, candidateDir) => {
  for (const [side, caseDir] of [['baseline', baselineDir], ['candidate', candidateDir]]) {
    const capturesPath = join(caseDir, 'captures', caseId + '-turn-1-client.json');
    const capture = JSON.parse(readFileSync(capturesPath, 'utf8'));
    const text = Buffer.from(capture.client_response.bodyBytesBase64, 'base64').toString('latin1');
    const match = text.match(/"item_id":"(fc_dsml_\d+_\d+)"/);
    if (!match) throw new Error(side + ' client item_id not found in bytes');
    const itemId = match[1];
    const component = itemId.match(/^fc_dsml_(\d+)_/)[1];
    const undeclared = itemId.replace('fc_dsml_' + component + '_', 'fc_dsml_' + component + '_91');
    const next = text.replace('"item_id":"' + itemId + '"', '"item_id":"' + undeclared + '"');
    if (next === text) throw new Error(side + ' raw-only item_id mutation did not apply');
    setClientBytesOnly(capture, Buffer.from(next, 'latin1'));
    writeFileSync(capturesPath, JSON.stringify(capture, null, 2) + '\n');
  }
  return { injected: 'raw-only item_id' };
});

// fix9-review-1b: a raw-only native call ID mutation must break follow-up pairing.
results.client_raw_only_call_id = withBothCopies((baselineDir, candidateDir) => {
  for (const [side, caseDir] of [['baseline', baselineDir], ['candidate', candidateDir]]) {
    const capturesPath = join(caseDir, 'captures', caseId + '-turn-1-client.json');
    const capture = JSON.parse(readFileSync(capturesPath, 'utf8'));
    const text = Buffer.from(capture.client_response.bodyBytesBase64, 'base64').toString('latin1');
    const at = text.indexOf('call_dsml_');
    if (at < 0) throw new Error(side + ' native call ID not found in bytes');
    let j = at;
    while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
    const callId = text.slice(at, j);
    if (!callId.endsWith('_0')) throw new Error(side + ' unexpected native call ID ' + callId);
    const next = text.split(callId).join(callId.replace(/_0$/, '_99'));
    setClientBytesOnly(capture, Buffer.from(next, 'latin1'));
    writeFileSync(capturesPath, JSON.stringify(capture, null, 2) + '\n');
  }
  return { injected: 'raw-only native call ID' };
});

// fix9-review-2: a bare data line adds a second data field and keeps the event
// byte-significant instead of being normalized.
results.client_multiple_data_fields = withBothCopies((baselineDir, candidateDir) => {
  for (const [side, caseDir] of [['baseline', baselineDir], ['candidate', candidateDir]]) {
    const capturesPath = join(caseDir, 'captures', caseId + '-turn-1-client.json');
    const capture = JSON.parse(readFileSync(capturesPath, 'utf8'));
    const bodyText = String(capture.client_response.bodyText);
    const marker = '"type":"response.function_call_arguments.delta"';
    const mAt = bodyText.indexOf(marker);
    if (mAt < 0) throw new Error(side + ' delta data line not found');
    const lineEnd = bodyText.indexOf('\n', mAt);
    if (lineEnd < 0) throw new Error(side + ' delta line terminator not found');
    setClientBody(capture, bodyText.slice(0, lineEnd) + '\ndata' + bodyText.slice(lineEnd));
    writeFileSync(capturesPath, JSON.stringify(capture, null, 2) + '\n');
  }
  return { injected: 'multiple data fields' };
});

// fix10-1: the native call ID must come from dispatched protocol events, never
// from an SSE comment that the byte comparison strips.
results.client_comment_witness = withBothCopies((baselineDir, candidateDir) => {
  for (const [side, caseDir] of [['baseline', baselineDir], ['candidate', candidateDir]]) {
    const capturesPath = join(caseDir, 'captures', caseId + '-turn-1-client.json');
    const capture = JSON.parse(readFileSync(capturesPath, 'utf8'));
    const text = Buffer.from(capture.client_response.bodyBytesBase64, 'base64').toString('latin1');
    const match = text.match(/(call_dsml_\d+_\d+)/);
    if (!match) throw new Error(side + ' native call ID not found');
    const original = match[1];
    const mutated = text.split(original).join('call_mutated_native_witness');
    const next = ': witness ' + original + '\n\n' + mutated;
    setClientBytesOnly(capture, Buffer.from(next, 'latin1'));
    capture.client_response.bodyText = next;
    writeFileSync(capturesPath, JSON.stringify(capture, null, 2) + '\n');
  }
  return { injected: 'comment-only native call witness' };
});

// fix10-2: one leading UTF-8 BOM must still recognise a bare data field so the
// event stays byte-significant.
results.client_bom_bare_data = withBothCopies((baselineDir, candidateDir) => {
  for (const [side, caseDir] of [['baseline', baselineDir], ['candidate', candidateDir]]) {
    const capturesPath = join(caseDir, 'captures', caseId + '-turn-1-client.json');
    const capture = JSON.parse(readFileSync(capturesPath, 'utf8'));
    const text = Buffer.from(capture.client_response.bodyBytesBase64, 'base64').toString('latin1');
    const marker = '"type":"response.function_call_arguments.delta"';
    const mAt = text.indexOf(marker);
    if (mAt < 0) throw new Error(side + ' delta data line not found');
    const lineStart = text.lastIndexOf('\n', mAt) + 1;
    setClientBody(capture, text.slice(0, lineStart) + '\uFEFFdata\n' + text.slice(lineStart));
    writeFileSync(capturesPath, JSON.stringify(capture, null, 2) + '\n');
  }
  return { injected: 'BOM-prefixed bare data field' };
});

function outcomeEntry(name, expectedErrors) {
  const result = results[name];
  return {
    ...result.mutation,
    comparator_status: result.receipt.status,
    rejected: result.receipt.status !== 'PASS'
      && expectedErrors.some((needle) => result.caseReceipt.errors.some((error) => error.includes(needle))),
    errors: result.caseReceipt.errors,
  };
}
const outcome = {
  expected: 'reject all counterexamples',
  provider_bound_result_id: outcomeEntry('provider_bound_result_id', ['provider-bound follow-up call/result IDs']),
  provider_request_byte_mutation: outcomeEntry('provider_request_byte_mutation', ['provider request/wire/sequence differs']),
  client_item_reference: outcomeEntry('client_item_reference', ['client/input/completion bytes differ']),
  client_item_reference_literal_token: outcomeEntry('client_item_reference_literal_token', ['do not match declared items', 'client/input/completion bytes differ']),
  client_metadata_id: outcomeEntry('client_metadata_id', ['client/input/completion bytes differ']),
  client_metadata_call_id: outcomeEntry('client_metadata_call_id', ['client/input/completion bytes differ']),
  client_metadata_item_id: outcomeEntry('client_metadata_item_id', ['client/input/completion bytes differ']),
  client_metadata_output_id: outcomeEntry('client_metadata_output_id', ['client/input/completion bytes differ']),
  client_item_wire_escape: outcomeEntry('client_item_wire_escape', ['client/input/completion bytes differ']),
  client_created_item_id_extension: outcomeEntry('client_created_item_id_extension', ['client/input/completion bytes differ']),
  client_created_item_id_declaration: outcomeEntry('client_created_item_id_declaration', ['do not match declared items']),
  client_unsupported_event_item_id: outcomeEntry('client_unsupported_event_item_id', ['client/input/completion bytes differ']),
  client_message_item_call_id: outcomeEntry('client_message_item_call_id', ['client/input/completion bytes differ']),
  client_bare_cr_unresolved_reference: outcomeEntry('client_bare_cr_unresolved_reference', ['do not match declared items']),
  client_duplicate_item_id: outcomeEntry('client_duplicate_item_id', ['client/input/completion bytes differ', 'do not match declared items']),
  client_entity_body_bytes: outcomeEntry('client_entity_body_bytes', ['client/input/completion bytes differ']),
  client_unterminated_declaration: outcomeEntry('client_unterminated_declaration', ['do not match declared items']),
  client_multiline_split_event: outcomeEntry('client_multiline_split_event', ['client/input/completion bytes differ']),
  provider_capture_missing_bytes: outcomeEntry('provider_capture_missing_bytes', ['provider request pre-decode bytes missing']),
  provider_raw_decoded_disagreement: outcomeEntry('provider_raw_decoded_disagreement', ['provider-bound follow-up call/result IDs']),
  client_raw_only_item_id: outcomeEntry('client_raw_only_item_id', ['do not match declared items']),
  client_raw_only_call_id: outcomeEntry('client_raw_only_call_id', ['harvested call ID does not pair', 'provider-bound follow-up call/result IDs']),
  client_multiple_data_fields: outcomeEntry('client_multiple_data_fields', ['client/input/completion bytes differ']),
  client_comment_witness: outcomeEntry('client_comment_witness', ['harvested call ID does not pair', 'process-generated DSML IDs were not present']),
  client_bom_bare_data: outcomeEntry('client_bom_bare_data', ['client/input/completion bytes differ']),
};
const keepaliveCheck = (() => {
  const business = 'data: {"type":"response.created","response":{"id":"probe"}}\n\n';
  const second = 'data: {"type":"response.done","response":{"id":"probe"}}\n\n';
  const output = withoutKeepalives(Buffer.from(business + ': keepalive\n\n' + second, 'latin1')).toString('latin1');
  return {
    removed_comment_only: !output.includes(': keepalive'),
    kept_business_frames: output.includes('data: {"type":"response.created"') && output.includes('data: {"type":"response.done"'),
    exact_bytes: output === business + second,
  };
})();
const outcomeJson = { ...outcome, keepalive_dispatch: keepaliveCheck };
writeFileSync(join(evidenceRoot, 'comparator-counterexample.json'), JSON.stringify(outcomeJson, null, 2) + '\n');
console.log(JSON.stringify(outcomeJson, null, 2));
if (Object.values(outcome).slice(1).some((entry) => !entry.rejected)) process.exitCode = 1;
if (!keepaliveCheck.removed_comment_only || !keepaliveCheck.kept_business_frames || !keepaliveCheck.exact_bytes) process.exitCode = 1;
