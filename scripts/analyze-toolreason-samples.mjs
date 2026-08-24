#!/usr/bin/env node
/**
 * Machine summary for live toolreason samples.
 *
 * This is deliberately read-only. It counts provider tool-call turns and
 * raw toolreason markers from the canonical ~/.rcc sample tree; it never
 * infers OK/MISSING from a single log line. Pass --observations when a
 * captured TOOLREASON console stream is available.
 *
 * Usage:
 *   node scripts/analyze-toolreason-samples.mjs --port 7777 --limit 200
 *   node scripts/analyze-toolreason-samples.mjs --json
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const options = {
  root: path.join(os.homedir(), '.rcc', 'codex-samples'),
  protocol: 'openai-responses',
  port: null,
  limit: 200,
  observations: null,
  json: false,
};
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--root') options.root = path.resolve(argv[++i]);
  else if (arg === '--protocol') options.protocol = argv[++i];
  else if (arg === '--port') options.port = argv[++i];
  else if (arg === '--limit') options.limit = Number(argv[++i]);
  else if (arg === '--observations') options.observations = path.resolve(argv[++i]);
  else if (arg === '--json') options.json = true;
}

async function directories(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

function walk(value, visit) {
  visit(value);
  if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => walk(item, visit));
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value).map(([key, item]) => `${key}:${textOf(item)}`).join(' ');
}

function countToolCalls(value) {
  let count = 0;
  const identities = new Set();
  const add = (item, syntheticIdentity) => {
    // Streaming tool fragments often carry the id only on the first chunk;
    // use the stable tool-call index when present so one fragmented call is
    // not counted as both `id` and a later synthetic fragment identity.
    const identity = item?.index !== undefined && item?.index !== null
      ? `index:${item.index}`
      : item?.call_id ?? item?.id ?? syntheticIdentity;
    if (identity !== undefined && identity !== null) {
      const key = String(identity);
      if (identities.has(key)) return;
      identities.add(key);
    }
    count += 1;
  };
  walk(value, (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    if (item.type === 'tool_use' || item.type === 'function_call' || item.type === 'custom_tool_call') add(item);
    if (Array.isArray(item.tool_calls)) item.tool_calls.forEach((call, index) => add(call, `tool_call_${index}`));
  });
  walk(value, (item) => {
    if (!item || typeof item !== 'object' || typeof item.rawSse !== 'string') return;
    for (const line of item.rawSse.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try {
        const event = JSON.parse(line.slice(5).trim());
        const eventType = event.type;
        if (eventType === 'content_block_start' && event.content_block?.type === 'tool_use') {
          add(event.content_block, `anthropic_${event.index ?? count}`);
        }
        if (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') {
          const itemValue = event.item;
          if (itemValue?.type === 'function_call' || itemValue?.type === 'custom_tool_call') {
            add(itemValue, `responses_${event.output_index ?? count}`);
          }
        }
        for (const itemValue of event.response?.output ?? []) {
          if (itemValue?.type === 'function_call' || itemValue?.type === 'custom_tool_call') {
            add(itemValue, `responses_output_${itemValue.id ?? count}`);
          }
        }
        for (const call of event.choices?.flatMap((choice) => choice.delta?.tool_calls ?? []) ?? []) {
          add(call, `chat_${call.index ?? count}`);
        }
        for (const call of event.choices?.flatMap((choice) => choice.message?.tool_calls ?? []) ?? []) {
          add(call, `chat_message_${call.index ?? count}`);
        }
      } catch { /* diagnostic input only */ }
    }
  });
  return count;
}

function promptLocations(request) {
  const found = { instructions: 0, system: 0, developer: 0, tool_description: 0 };
  walk(request, (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const schema = item.parameters ?? item.input_schema;
    const properties = schema && typeof schema === 'object' ? schema.properties : null;
    const hasReasonSchema = properties && typeof properties === 'object' &&
      Object.prototype.hasOwnProperty.call(properties, 'reason');
    const hasReasonGuidance = typeof item.description === 'string' &&
      item.description.includes('reason');
    if (!hasReasonSchema && !hasReasonGuidance) return;
    if (typeof item.instructions === 'string') found.instructions += 1;
    if (item.role === 'system') found.system += 1;
    if (item.role === 'developer') found.developer += 1;
    if (hasReasonSchema || hasReasonGuidance) found.tool_description += 1;
  });
  return found;
}

function toolCallReasonFields(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  let raw = null;
  if (item.type === 'tool_use' || item.type === 'custom_tool_call') raw = item.input;
  else if (item.type === 'function_call') raw = item.arguments;
  else if (item.function && typeof item.function === 'object') raw = item.function.arguments;
  if (raw === null || raw === undefined) return null;
  const parsed = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

function clientPayload(response) {
  if (!response || typeof response !== 'object') return null;
  if (typeof response.rawSse === 'string') {
    const events = [];
    for (const line of response.rawSse.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* incomplete diagnostic frame */ }
    }
    return events;
  }
  if (response.rawBody && typeof response.rawBody === 'object') return response.rawBody;
  return null;
}

function countClientProjection(response) {
  const payload = clientPayload(response);
  let count = 0;
  const identities = new Set();
  const add = (identity) => {
    const key = String(identity);
    if (identities.has(key)) return;
    identities.add(key);
    count += 1;
  };

  if (Array.isArray(payload)) {
    payload.forEach((event, index) => {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'response.output_item.done' && event.item?.type === 'reasoning' &&
          Array.isArray(event.item.summary) && event.item.summary.some((summary) =>
            summary && typeof summary.text === 'string' && /^调用工具\s+/.test(summary.text.trim()))) {
        add(`responses:reasoning:${event.output_index ?? index}`);
      }
      if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
        add(`anthropic:thinking:${event.index ?? index}`);
      }
      const deltas = event.choices?.flatMap((choice) => {
        const delta = choice?.delta;
        return delta && typeof delta.reasoning_content === 'string' && delta.reasoning_content.trim()
          ? [`${choice.index ?? 0}`]
          : [];
      }) ?? [];
      deltas.forEach((identity) => add(`chat:reasoning:${identity}`));
    });
    return count;
  }

  walk(payload, (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    if (typeof item.reasoning_content === 'string' && item.reasoning_content.trim()) {
      add(`reasoning_content:${item.reasoning_content}`);
    }
    if (item.type === 'thinking' && typeof item.thinking === 'string' && item.thinking.trim()) {
      add(`thinking:${item.thinking}`);
    }
    if (item.type === 'reasoning') {
      if (item.id === 'rcc_reason_anthropic_tool_call') {
        add(`reasoning:${item.id}`);
      }
      if (Array.isArray(item.summary) && item.summary.some((summary) =>
        summary && typeof summary.text === 'string' && /^调用工具\s+/.test(summary.text.trim()))) {
        add(`reasoning:toolreason:${item.summary.map((summary) => summary?.text ?? '').join('\n')}`);
      }
    }
  });
  return count;
}

function countClientAuxiliaryLeakage(response) {
  const payload = clientPayload(response);
  let count = 0;
  walk(payload, (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    for (const key of ['goal_alignment_confidence', 'model_id']) {
      if (Object.prototype.hasOwnProperty.call(item, key)) count += 1;
    }
    if (Object.prototype.hasOwnProperty.call(item, 'reason') &&
        (item.type === 'tool_use' || item.type === 'function_call' ||
         item.type === 'custom_tool_call' || item.function)) {
      count += 1;
    }
  });
  return count;
}

function inspectToolreason(value) {
  const result = { calls: 0, reason: 0, confidence: 0, model: 0, valid: 0 };
  const seenCalls = new Set();
  const inspect = (candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    const isCall = candidate.type === 'tool_use' || candidate.type === 'function_call' ||
      candidate.type === 'custom_tool_call' || (candidate.function && typeof candidate.function === 'object');
    if (!isCall) return;
    if (candidate.status === 'in_progress' &&
      ((typeof candidate.arguments === 'string' && !candidate.arguments.trim()) ||
       (typeof candidate.input === 'string' && !candidate.input.trim()))) return;
    const fields = toolCallReasonFields(candidate);
    const identity = candidate.call_id ?? candidate.id ?? candidate.function?.name;
    if (identity && seenCalls.has(identity)) return;
    const hasReason = fields && typeof fields.reason === 'string' && fields.reason.trim().length > 0;
    if (identity) seenCalls.add(identity);
    result.calls += 1;
    if (!fields) return;
    const hasConfidence = Number.isInteger(fields.goal_alignment_confidence) &&
      fields.goal_alignment_confidence >= 0 && fields.goal_alignment_confidence <= 100;
    const hasModel = typeof fields.model_id === 'string' && fields.model_id.trim().length > 0;
    if (hasReason) result.reason += 1;
    if (hasConfidence) result.confidence += 1;
    if (hasModel) result.model += 1;
    if (hasReason) result.valid += 1;
  };
  walk(value, (item) => {
    inspect(item);
  });
  walk(value, (item) => {
    if (!item || typeof item !== 'object' || typeof item.rawSse !== 'string') return;
    const partialInputs = new Map();
    for (const line of item.rawSse.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try {
        const event = JSON.parse(line.slice(5).trim());
        const block = event.content_block;
        if (event.type === 'content_block_start' && block?.type === 'tool_use') {
          partialInputs.set(event.index, {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input && typeof block.input === 'object' && Object.keys(block.input).length > 0
              ? JSON.stringify(block.input)
              : '',
          });
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
          const pending = partialInputs.get(event.index);
          if (pending) pending.input += event.delta.partial_json ?? '';
        }
        inspect(event);
        inspect(event.item);
        for (const item of event.response?.output ?? []) inspect(item);
        for (const choice of event.choices ?? []) {
          for (const call of choice.delta?.tool_calls ?? []) inspect(call);
          for (const call of choice.message?.tool_calls ?? []) inspect(call);
        }
        for (const block of event.content ?? []) inspect(block);
      } catch { /* diagnostic input only */ }
    }
    for (const pending of partialInputs.values()) {
      try { pending.input = JSON.parse(pending.input); } catch { continue; }
      inspect(pending);
    }
  });
  return result;
}

function observeFile(file) {
  return fs.readFile(file, 'utf8').then((raw) => {
    const rows = raw.split(/\r?\n/).filter(Boolean);
    return {
      ok: rows.filter((row) => /TOOLREASON OK\b/.test(row)).length,
      missing: rows.filter((row) => /TOOLREASON MISSING\b/.test(row)).length,
      lines: rows.length,
    };
  }).catch(() => ({ ok: 0, missing: 0, lines: 0 }));
}

function firstProviderResponse(response) {
  return response?.attempts?.[0]?.response ?? null;
}

function transactionRecord({ sample, port, request, response, clientResponse, error, calls, toolreason, locations }) {
  const providerResponse = firstProviderResponse(response);
  const clientMaterialized = clientResponse?.materializedResponse;
  const projection = countClientProjection(clientResponse);
  const leakage = countClientAuxiliaryLeakage(clientResponse);
  const status = error?.status ?? response?.status ?? response?.responseStatus ?? clientResponse?.status ?? null;
  return {
    sample: path.basename(sample),
    port,
    request_id: providerResponse?.requestId ?? path.basename(sample),
    session_id: request?.client_metadata?.session_id ?? request?.client_metadata?.thread_id ?? null,
    provider: providerResponse?.providerId ?? null,
    client_model: request?.model ?? null,
    client_finish_reason: clientMaterialized?.finish_reason ?? null,
    status,
    tool_calls: calls,
    provider_reason_calls: toolreason.reason,
    provider_confidence_calls: toolreason.confidence,
    provider_model_calls: toolreason.model,
    client_reasoning_projections: projection,
    client_auxiliary_leakage: leakage,
    client_snapshot_present: clientResponse !== null,
    raw_reason_without_client_projection: toolreason.reason > 0 && clientResponse !== null && projection === 0,
    client_snapshot_error: clientResponse?.error?.code ?? null,
    guidance_tool_surfaces: locations.tool_description,
    projection_at_most_one: projection <= 1,
    mapping_error: status === 400 || status === 500 || status === 502,
  };
}

async function main() {
  const portRoot = path.join(options.root, options.protocol, 'ports');
  const ports = options.port ? [path.join(portRoot, options.port)] : await directories(portRoot);
  const samples = [];
  for (const port of ports) {
    for (const sample of await directories(port)) {
      const stat = await fs.stat(sample).catch(() => null);
      if (stat) samples.push({ sample, mtime: stat.mtimeMs, port: path.basename(port) });
    }
  }
  samples.sort((a, b) => b.mtime - a.mtime);
  const selected = samples.slice(0, options.limit);
  const result = {
    root: options.root,
    protocol: options.protocol,
    ports: [...new Set(selected.map((item) => item.port))],
    scanned_samples: selected.length,
    tool_call_samples: 0,
    tool_call_turns_estimate: 0,
    provider_tool_calls: 0,
    raw_toolreason_samples: 0,
    raw_toolreason_tags: 0,
    provider_reason_calls: 0,
    provider_reason_only_calls: 0,
    provider_confidence_calls: 0,
    provider_model_calls: 0,
    client_reasoning_projections: 0,
    client_auxiliary_leakage: 0,
    raw_reason_without_client_projection: 0,
    raw_reason_without_client_snapshot: 0,
    prompt_locations: { instructions: 0, system: 0, developer: 0, tool_description: 0 },
    status_counts: {},
    mapping_errors: 0,
    transaction_records: [],
    observation_logs: null,
    acceptance: { ok_plus_missing_equals_tool_call_turns: null, source: 'provider samples alone cannot prove runtime OK/MISSING coverage' },
    examples: [],
  };
  for (const item of selected) {
    const request = await readJson(path.join(item.sample, 'provider-request.json'));
    const response = await readJson(path.join(item.sample, 'provider-response.json'));
    const clientResponse = await readJson(path.join(item.sample, 'response.json'));
    const error = await readJson(path.join(item.sample, 'error.json'));
    const calls = countToolCalls(response);
    const toolreason = inspectToolreason(response);
    const locations = promptLocations(request);
    const hasStatus = error?.status ?? response?.status ?? response?.responseStatus;
    const projection = countClientProjection(clientResponse);
    const leakage = countClientAuxiliaryLeakage(clientResponse);
    if (toolreason.reason > 0 && clientResponse !== null && projection === 0) {
      result.raw_reason_without_client_projection += 1;
    }
    if (toolreason.reason > 0 && clientResponse === null) {
      result.raw_reason_without_client_snapshot += 1;
    }
    if (calls > 0 || projection > 0 || error) {
      result.transaction_records.push(transactionRecord({
        sample: item.sample,
        port: item.port,
        request: await readJson(path.join(item.sample, 'request.json')),
        response,
        clientResponse,
        error,
        calls,
        toolreason,
        locations,
      }));
    }
    if (calls > 0) {
      result.tool_call_samples += 1;
      result.tool_call_turns_estimate += 1;
      if (result.examples.length < 5) {
        result.examples.push({
          sample: path.basename(item.sample),
          calls,
          provider_reason_calls: toolreason.reason,
          provider_confidence_calls: toolreason.confidence,
          provider_model_calls: toolreason.model,
          locations,
        });
      }
    }
    if (toolreason.reason > 0) result.raw_toolreason_samples += 1;
    result.provider_reason_calls += toolreason.reason;
    result.provider_tool_calls += toolreason.calls;
    result.provider_reason_only_calls += toolreason.valid;
    result.provider_confidence_calls += toolreason.confidence;
    result.provider_model_calls += toolreason.model;
    result.client_reasoning_projections += projection;
    result.client_auxiliary_leakage += leakage;
    Object.entries(locations).forEach(([key, value]) => { result.prompt_locations[key] += value; });
    if (hasStatus !== undefined && hasStatus !== null) {
      const key = String(hasStatus);
      result.status_counts[key] = (result.status_counts[key] || 0) + 1;
      if (key === '400' || key === '502') result.mapping_errors += 1;
    }
  }
  if (options.observations) {
    result.observation_logs = await observeFile(options.observations);
    result.acceptance = {
      ok_plus_missing_equals_tool_call_turns:
        result.observation_logs.ok + result.observation_logs.missing === result.tool_call_turns_estimate,
      source: 'provider sample estimate + supplied TOOLREASON log',
    };
  }
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`toolreason samples: ${result.scanned_samples}`);
    console.log(`tool-call turns (estimate): ${result.tool_call_turns_estimate}`);
    console.log(`provider tool calls: ${result.provider_tool_calls}`);
    console.log(`provider reason calls: ${result.provider_reason_calls}`);
    console.log(`provider confidence calls: ${result.provider_confidence_calls}`);
    console.log(`provider model calls: ${result.provider_model_calls}`);
    console.log(`raw reason without client projection: ${result.raw_reason_without_client_projection}`);
    console.log(`raw reason without client snapshot: ${result.raw_reason_without_client_snapshot}`);
    console.log(`prompt locations: ${JSON.stringify(result.prompt_locations)}`);
    console.log(`400/502 samples: ${result.mapping_errors}`);
    console.log(`OK/MISSING coverage: ${result.acceptance.ok_plus_missing_equals_tool_call_turns ?? 'not measurable without --observations'}`);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
