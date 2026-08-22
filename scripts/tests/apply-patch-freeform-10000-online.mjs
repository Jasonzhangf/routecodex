#!/usr/bin/env node
const endpoint = process.env.RCC_APPLY_PATCH_ONLINE_URL || 'http://172.30.215.14:10000/v1/responses';
const timeoutMs = Number(process.env.RCC_APPLY_PATCH_ONLINE_TIMEOUT_MS || 120000);
const patchText = [
  '*** Begin Patch',
  '*** Add File: tmp/routecodex-online-apply-patch-smoke.txt',
  '+hello from routecodex online apply_patch smoke',
  '*** End Patch',
].join('\n');
const applyPatchGrammar = [
  'start: begin_patch hunk+ end_patch',
  'begin_patch: "*** Begin Patch" LF',
  'end_patch: "*** End Patch" LF?',
  'hunk: add_hunk | delete_hunk | update_hunk',
  'add_hunk: "*** Add File: " filename LF add_line+',
  'delete_hunk: "*** Delete File: " filename LF',
  'update_hunk: "*** Update File: " filename LF change_move? change?',
  'filename: /(.+)/',
  'add_line: "+" /(.*)/ LF',
  'change_move: "*** Move to: " filename LF',
  'change: (change_context | change_line)+ eof_line?',
  'change_context: ("@@" | "@@ " /(.+)/) LF',
  'change_line: ("+" | "-" | " ") /(.*)/ LF',
  'eof_line: "*** End of File" LF',
  '%import common.LF',
].join('\n');

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), timeoutMs);

function parseSse(text) {
  const events = [];
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split(/\n/);
    const event = lines
      .find((line) => line.startsWith('event:'))
      ?.slice('event:'.length)
      .trim();
    const dataLines = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const data = dataLines.join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      events.push({ event, data: JSON.parse(data) });
    } catch {
      events.push({ event, data: { __raw: data } });
    }
  }
  return events;
}

function collectArguments(value, path = '$', out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectArguments(item, `${path}[${index}]`, out));
    return out;
  }
  if (typeof value.arguments === 'string') out.push({ path: `${path}.arguments`, value: value.arguments });
  for (const [key, child] of Object.entries(value)) collectArguments(child, `${path}.${key}`, out);
  return out;
}

function collectCustomToolInputs(value, path = '$', out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectCustomToolInputs(item, `${path}[${index}]`, out));
    return out;
  }
  if (
    value.type === 'custom_tool_call'
    && value.name === 'apply_patch'
    && typeof value.input === 'string'
  ) {
    out.push({ path: `${path}.input`, value: value.input });
  }
  for (const [key, child] of Object.entries(value)) collectCustomToolInputs(child, `${path}.${key}`, out);
  return out;
}

function eventText(event) {
  return JSON.stringify(event);
}

function assertNoWrappedApplyPatchLeak(events) {
  const leaks = [];
  for (const [index, event] of events.entries()) {
    const text = eventText(event);
    if (!text.includes('apply_patch') && !text.includes('Begin Patch') && !text.includes('patch')) continue;
    if (text.includes('{\\"patch\\"') || text.includes('"arguments":"{\\\\\\"patch\\\\\\"') || text.includes('"delta":"{\\\\\\"patch\\\\\\"')) {
      leaks.push({ index, event: event.event, snippet: text.slice(0, 800) });
    }
  }
  if (leaks.length > 0) {
    throw new Error(`client-visible JSON-wrapped apply_patch leak: ${JSON.stringify(leaks, null, 2)}`);
  }
}

function collectDeltaStreams(events) {
  const streams = new Map();
  for (const event of events) {
    const data = event.data;
    if (event.event !== 'response.function_call_arguments.delta') continue;
    if (!data || typeof data !== 'object') continue;
    if (data.name !== 'apply_patch') continue;
    const callId = typeof data.call_id === 'string' ? data.call_id : 'call_apply_patch';
    const delta = typeof data.delta === 'string' ? data.delta : '';
    streams.set(callId, `${streams.get(callId) ?? ''}${delta}`);
  }
  return streams;
}

const body = {
  model: process.env.RCC_APPLY_PATCH_ONLINE_MODEL || 'gpt-5.5',
  input: [
    {
      role: 'user',
      content:
        'Call the apply_patch tool exactly once. Use this exact patch text as the tool arguments, not prose:\n' +
        patchText,
    },
  ],
  tools: [
    {
      type: 'custom',
      name: 'apply_patch',
      description:
        'Use the apply_patch tool. FREEFORM grammar: arguments must be the raw patch string, not JSON.',
      format: {
        type: 'grammar',
        syntax: 'lark',
        definition: applyPatchGrammar,
      },
    },
  ],
  tool_choice: { type: 'custom', name: 'apply_patch' },
  stream: true,
};

try {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${process.env.RCC_APPLY_PATCH_ONLINE_API_KEY || 'test'}`,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    throw new Error(`expected SSE content-type, got ${contentType || '<empty>'}`);
  }
  const events = parseSse(text);
  assertNoWrappedApplyPatchLeak(events);
  const customInputs = collectCustomToolInputs(events);
  const customPatchCandidate = customInputs.find((item) => item.value.includes('*** Begin Patch'));
  if (!customPatchCandidate) {
    throw new Error(`missing apply_patch custom_tool_call.input in SSE; candidates=${JSON.stringify(customInputs).slice(0, 1000)}`);
  }
  if (customPatchCandidate.value.trim() !== patchText) {
    throw new Error(`apply_patch custom_tool_call.input changed semantics at ${customPatchCandidate.path}: ${customPatchCandidate.value}`);
  }
  const argumentCandidates = collectArguments(events);
  const applyPatchFunctionArgs = argumentCandidates.filter((arg) =>
    arg.value.includes('*** Begin Patch')
    && !arg.path.includes('.required_action.')
    && !arg.path.includes('.submit_tool_outputs.')
  );
  if (applyPatchFunctionArgs.length > 0) {
    throw new Error(`apply_patch leaked function_call arguments instead of custom_tool_call.input: ${JSON.stringify(applyPatchFunctionArgs).slice(0, 1000)}`);
  }
  const deltaStreams = collectDeltaStreams(events);
  for (const [callId, deltaText] of deltaStreams.entries()) {
    if (deltaText.includes('"patch"') || deltaText.trim().startsWith('{')) {
      throw new Error(`apply_patch delta stream is JSON-wrapped for ${callId}: ${deltaText}`);
    }
    if (deltaText.includes('*** Begin Patch') && deltaText.trim() !== patchText) {
      throw new Error(`apply_patch delta stream changed semantics for ${callId}: ${deltaText}`);
    }
  }
  console.log(JSON.stringify({
    ok: true,
    endpoint,
    eventCount: events.length,
    customInputCount: customInputs.length,
    functionArgumentPatchLeakCount: applyPatchFunctionArgs.length,
    deltaStreamCount: deltaStreams.size,
    input: customPatchCandidate.value,
  }, null, 2));
} finally {
  clearTimeout(timeout);
}
