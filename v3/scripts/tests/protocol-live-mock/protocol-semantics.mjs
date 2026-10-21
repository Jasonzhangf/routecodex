/**
 * Protocol observation helpers for the live mock matrix test infrastructure.
 *
 * This module parses test observations only. It never makes lifecycle,
 * routing, health, or delivery decisions, and it never guesses semantics for
 * unknown protocols or content types.
 */

export const SUPPORTED_PROTOCOLS = Object.freeze(['openai_chat', 'responses', 'anthropic', 'gemini']);

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function looksLikeSseText(bodyText) {
  if (typeof bodyText !== 'string') return false;
  return /(?:^|\r\n|\n|\r)(?:data|event):/.test(bodyText);
}

/**
 * Parse an SSE stream into ordered event observations.
 *
 * Each observation has `event`, `data`, and `raw_data`. `data` is the parsed
 * JSON value when the data field is valid JSON; otherwise it is the exact
 * literal string. Raw `[DONE]` stays the literal `[DONE]`, never a JSON-
 * quoted string. CRLF/LF, comments, multiline data, and data-less events are
 * supported. A stream ending inside a complete event is flushed; a stream
 * ending inside a data field is returned as a raw literal, never as a
 * fabricated semantic value.
 */
export function parseSse(text) {
  if (typeof text !== 'string') throw new TypeError('parseSse expects a string');
  const lines = text.split(/\r\n|\n|\r/);
  const frames = [];
  let event = null;
  let dataParts = [];

  const flush = () => {
    if (event === null && dataParts.length === 0) return;
    const rawData = dataParts.join('\n');
    const parsed = tryParseJson(rawData);
    frames.push({
      event: event === null ? 'message' : event,
      data: parsed === null ? rawData : parsed,
      raw_data: rawData,
    });
    event = null;
    dataParts = [];
  };

  for (const line of lines) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trimStart();
      continue;
    }
    if (line.startsWith('data:')) {
      dataParts.push(line.slice('data:'.length).trimStart());
      continue;
    }
  }
  flush();
  return frames;
}

/**
 * Parse a client body into a structured observation useful to assertions and
 * a tool consumer.
 *
 * JSON: `{ protocol, kind: 'json', content_type, ok, body, semantic: body }`.
 * SSE: `{ protocol, kind: 'sse', content_type, ok, frames, semantic }`.
 * Unknown/empty content: `{ kind: 'unknown', ok: false, error }`, with no
 * semantic fallback. Malformed JSON: `{ kind: 'error', ok: false, error }`.
 */
export function parseClientBody(entryProtocol, bodyText, contentType = '') {
  const text = typeof bodyText === 'string' ? bodyText : '';
  const normalized = String(contentType ?? '').toLowerCase();
  const isSseContentType = normalized.includes('event-stream');
  const isJsonContentType = normalized.includes('json');

  if (text.length === 0) return { protocol: entryProtocol, kind: 'unknown', content_type: contentType ?? '', ok: false, error: 'empty_body' };
  if (isSseContentType || (!isJsonContentType && looksLikeSseText(text))) {
    const frames = parseSse(text);
    return {
      protocol: entryProtocol,
      kind: 'sse',
      content_type: contentType ?? '',
      ok: true,
      frames,
      semantic: deriveSemanticObservation(entryProtocol, frames),
    };
  }
  if (isJsonContentType || normalized === '') {
    const body = tryParseJson(text);
    if (body === null) return { protocol: entryProtocol, kind: 'error', content_type: contentType ?? '', ok: false, error: 'malformed_json' };
    return { protocol: entryProtocol, kind: 'json', content_type: contentType ?? '', ok: true, body, semantic: body };
  }
  return { protocol: entryProtocol, kind: 'unknown', content_type: contentType ?? '', ok: false, error: 'unknown_content_type' };
}

/**
 * Derive assertion-level semantic observations from one protocol's parsed
 * events. This function only reads events that are already present in the
 * observation. It does not generate expected values, convert protocols, or
 * rewrite the raw `frames`/`body`.
 *
 * The returned object uses the same semantic field names as corpus
 * `expected_client.body_must`:
 * - shared: `text`, `usage`
 * - `openai_chat`: `finish_reason`, `message`, `tool_calls`
 * - `responses`: `status`, `item`, `output_items`
 * - `anthropic`: `stop_reason`
 * - `gemini`: `finishReason`, `candidate`, `candidates`
 */
export function deriveSemanticObservation(entryProtocol, frames) {
  if (!SUPPORTED_PROTOCOLS.includes(entryProtocol) || !Array.isArray(frames)) return {};

  if (entryProtocol === 'openai_chat') return deriveOpenAiChatSemantic(frames);
  if (entryProtocol === 'responses') return deriveResponsesSemantic(frames);
  if (entryProtocol === 'anthropic') return deriveAnthropicSemantic(frames);
  return deriveGeminiSemantic(frames);
}

const RESPONSES_ARGUMENTS_COMPLETE = Symbol('responsesArgumentsComplete');
const RESPONSES_INPUT_COMPLETE = Symbol('responsesInputComplete');
const RESPONSES_OUTPUT_INDEX = Symbol('responsesOutputIndex');

function frameData(frame) {
  return isObject(frame) && isObject(frame.data) ? frame.data : null;
}

function appendText(target, value) {
  if (typeof value === 'string') target.text = (target.text ?? '') + value;
}

function mergeUsage(target, usage) {
  if (!isObject(usage)) return;
  for (const [key, value] of Object.entries(usage)) {
    if (isObject(value)) {
      target[key] = mergeUsage(isObject(target[key]) ? target[key] : {}, value);
    } else if (value !== undefined) {
      target[key] = value;
    }
  }
  return target;
}

function toolIdentities(part) {
  if (!isObject(part)) return null;
  const identities = [];
  if (part.id !== undefined) identities.push(String(part.id));
  if (part.call_id !== undefined) identities.push(String(part.call_id));
  if (part.callId !== undefined) identities.push(String(part.callId));
  if (part.index !== undefined) identities.push(`index:${part.index}`);
  return identities.length > 0 ? identities : null;
}

function toolIdentity(part) {
  const identities = toolIdentities(part);
  return identities?.[0] ?? null;
}

function upsertToolCall(tools, tool) {
  const identities = toolIdentities(tool) ?? [];
  const primary = identities[0] ?? null;
  const indexIdentity = identities.find((identity) => identity.startsWith('index:'));
  let entry = indexIdentity === undefined
    ? null
    : tools.find((candidate) => toolIdentities(candidate)?.includes(indexIdentity));
  if (!entry && primary !== null) {
    entry = tools.find((candidate) => toolIdentities(candidate)?.includes(primary));
  }
  if (!entry) {
    entry = {
      ...(tool.index === undefined ? {} : { index: tool.index }),
      ...(tool.id === undefined ? {} : { id: tool.id }),
      ...(tool.call_id === undefined ? {} : { call_id: tool.call_id }),
      ...(tool.callId === undefined ? {} : { callId: tool.callId }),
      ...(tool.type === undefined ? {} : { type: tool.type }),
      function: {},
      _identities: identities,
    };
    tools.push(entry);
  }
  entry._identities = [...new Set([...(entry._identities ?? []), ...identities])];
  if (tool.function?.name !== undefined) entry.function.name = tool.function.name;
  if (tool.function?.arguments !== undefined) {
    entry.function.arguments = (entry.function.arguments ?? '') + tool.function.arguments;
  }
  return entry;
}

function deriveOpenAiChatSemantic(frames) {
  const semantic = {};
  const tools = [];
  const toolIdByIndex = new Map();
  for (const frame of frames) {
    const data = frameData(frame);
    if (!data) continue;
    if (data.usage !== undefined) semantic.usage = mergeUsage(semantic.usage ?? {}, data.usage);
    if (data.model !== undefined) semantic.model = data.model;
    if (!Array.isArray(data.choices)) continue;
    for (const choice of data.choices) {
      if (!isObject(choice)) continue;
      const delta = isObject(choice.delta) ? choice.delta : null;
      if (delta) {
        appendText(semantic, delta.content);
        for (const tool of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          if (tool?.index !== undefined && tool.id !== undefined) toolIdByIndex.set(tool.index, tool.id);
          const id = tool?.id ?? toolIdByIndex.get(tool?.index);
          upsertToolCall(tools, { ...tool, ...(id === undefined ? {} : { id }) });
        }
      }
      const message = isObject(choice.message) ? choice.message : null;
      if (message) {
        appendText(semantic, message.content);
        for (const tool of Array.isArray(message.tool_calls) ? message.tool_calls : []) upsertToolCall(tools, tool);
      }
      if (isNonEmptyString(choice.finish_reason)) semantic.finish_reason = choice.finish_reason;
    }
  }
  if (tools.length > 0) {
    for (const tool of tools) delete tool._identities;
    semantic.tool_calls = tools;
    const first = tools[0];
    semantic.message = {
      role: 'assistant',
      content: semantic.text ?? null,
      tool_calls: tools,
    };
    semantic.item = {
      type: 'function_call',
      name: first.function?.name,
      call_id: first.id ?? first.call_id ?? first.callId,
      arguments: first.function?.arguments ?? '',
    };
  } else if (semantic.text !== undefined) {
    semantic.message = { role: 'assistant', content: semantic.text };
  }
  return semantic;
}

function responsesItemFromEvent(data) {
  const candidates = [data.item, data.response?.output?.at(-1)];
  if (data.output_index !== undefined && Array.isArray(data.response?.output)) {
    candidates.push(data.response.output[data.output_index]);
  }
  if (data.item_id !== undefined && (data.arguments !== undefined || data.input !== undefined)) {
    candidates.push({
      id: data.item_id,
      ...(data.arguments === undefined ? {} : { arguments: data.arguments }),
      ...(data.input === undefined ? {} : { input: data.input }),
    });
  }
  return candidates.find(isObject) ?? null;
}

function mergeResponsesItem(target, item, options = {}) {
  if (!isObject(item)) return;
  for (const key of [
    'type',
    'id',
    'call_id',
    'name',
    'namespace',
    'role',
    'status',
    'input',
    'output',
    'encrypted_content',
    'summary',
  ]) {
    if (item[key] !== undefined) target[key] = item[key];
  }
  if (options.complete && item.arguments !== undefined) {
    target.arguments = item.arguments;
    target[RESPONSES_ARGUMENTS_COMPLETE] = true;
  } else if (item.arguments !== undefined && target[RESPONSES_ARGUMENTS_COMPLETE] !== true) {
    target.arguments = (target.arguments ?? '') + item.arguments;
  }
  if (options.complete && item.input !== undefined) {
    target[RESPONSES_INPUT_COMPLETE] = true;
  } else if (item.input !== undefined && target[RESPONSES_INPUT_COMPLETE] !== true) {
    target.input = (target.input ?? '') + item.input;
  }
  if (Array.isArray(item.content)) {
    target.content = structuredClone(item.content);
  }
}

function ensureResponsesOutputItem(outputItems, identity, match) {
  let item = outputItems.find((candidate) => candidate.id !== undefined && candidate.id === identity)
    || outputItems.find((candidate) => match?.(candidate));
  if (!item) {
    item = identity === undefined ? {} : { id: identity };
    outputItems.push(item);
  }
  return item;
}

function deriveResponsesSemantic(frames) {
  const semantic = {};
  const outputItems = [];
  for (const frame of frames) {
    const data = frameData(frame);
    if (!data) continue;
    if (data.usage !== undefined) semantic.usage = mergeUsage(semantic.usage ?? {}, data.usage);
    if (data.response?.usage !== undefined) semantic.usage = mergeUsage(semantic.usage ?? {}, data.response.usage);
    if (isNonEmptyString(data.status)) semantic.status = data.status;
    if (isNonEmptyString(data.response?.status)) semantic.status = data.response.status;
    if ((data.type === 'response.function_call_arguments.delta' || data.type === 'response.custom_tool_call_input.delta' || data.type === 'response.output_text.delta')
      && typeof data.delta === 'string') {
      const deltaItem = ensureResponsesOutputItem(outputItems, data.item_id, (candidate) => (candidate.call_id !== undefined && candidate.call_id === data.item_id)
        || (data.output_index !== undefined && candidate[RESPONSES_OUTPUT_INDEX] === data.output_index));
      if (data.output_index !== undefined) deltaItem[RESPONSES_OUTPUT_INDEX] = data.output_index;
      if (data.type === 'response.function_call_arguments.delta') {
        deltaItem.deltaArguments = (deltaItem.deltaArguments ?? '') + data.delta;
        deltaItem.arguments = deltaItem.deltaArguments;
      } else if (data.type === 'response.custom_tool_call_input.delta') {
        deltaItem.deltaInput = (deltaItem.deltaInput ?? '') + data.delta;
        deltaItem.input = deltaItem.deltaInput;
      } else {
        deltaItem.deltaText = (deltaItem.deltaText ?? '') + data.delta;
      }
      semantic.item = deltaItem;
    }
    const responseItems = Array.isArray(data.response?.output)
      ? data.response.output.map((item, index) => ({ item, index }))
      : [{ item: responsesItemFromEvent(data), index: data.output_index }];
    for (const { item: responseItem, index } of responseItems) {
      if (!isObject(responseItem)) continue;
      const merged = ensureResponsesOutputItem(
        outputItems,
        responseItem.id,
        (candidate) => (responseItem.call_id !== undefined
          && candidate.call_id !== undefined
          && candidate.call_id === responseItem.call_id)
          || (index !== undefined && candidate[RESPONSES_OUTPUT_INDEX] === index),
      );
      if (index !== undefined) merged[RESPONSES_OUTPUT_INDEX] = index;
      mergeResponsesItem(merged, responseItem, { complete: true });
      semantic.item = merged;
    }
  }
  outputItems.sort((a, b) => (a[RESPONSES_OUTPUT_INDEX] ?? 0) - (b[RESPONSES_OUTPUT_INDEX] ?? 0));
  for (const item of outputItems) {
    if (item[RESPONSES_ARGUMENTS_COMPLETE] !== true && item.deltaArguments !== undefined) item.arguments = item.deltaArguments;
    if (item[RESPONSES_INPUT_COMPLETE] !== true && item.deltaInput !== undefined) item.input = item.deltaInput;
    if (!Array.isArray(item.content) && typeof item.deltaText === 'string') {
      item.content = [{ type: 'output_text', text: item.deltaText }];
    }
    if (item.type === 'message' && item.role === 'assistant') {
      for (const part of item.content ?? []) {
        if (part?.type === 'output_text') appendText(semantic, part.text);
      }
    } else if (item.type === undefined && typeof item.deltaText === 'string') {
      appendText(semantic, item.deltaText);
    }
    delete item.deltaArguments;
    delete item.deltaInput;
    delete item.deltaText;
    delete item[RESPONSES_ARGUMENTS_COMPLETE];
    delete item[RESPONSES_INPUT_COMPLETE];
    delete item[RESPONSES_OUTPUT_INDEX];
  }
  if (outputItems.length > 0) {
    semantic.output_items = outputItems;
    semantic.item = outputItems.at(-1);
  }
  return semantic;
}

function deriveAnthropicSemantic(frames) {
  const semantic = {};
  const blocks = [];
  for (const frame of frames) {
    const data = frameData(frame);
    if (!data) continue;
    if (data.usage !== undefined) semantic.usage = mergeUsage(semantic.usage ?? {}, data.usage);
    if (data.message?.usage !== undefined) semantic.usage = mergeUsage(semantic.usage ?? {}, data.message.usage);
    if (data.message?.model !== undefined) semantic.model = data.message.model;
    if (data.stop_reason !== undefined) semantic.stop_reason = data.stop_reason;
    if (data.delta?.stop_reason !== undefined) semantic.stop_reason = data.delta.stop_reason;
    if (data.message?.stop_reason !== undefined) semantic.stop_reason = data.message.stop_reason;
    if (data.delta?.type === 'text_delta') appendText(semantic, data.delta.text);
    if (data.type === 'content_block_start' && isObject(data.content_block)) {
      const block = { ...data.content_block };
      if (data.index !== undefined) block.index = data.index;
      blocks[data.index ?? blocks.length] = block;
      if (block.text !== undefined) appendText(semantic, block.text);
    }
    if (data.type === 'content_block_delta' && isObject(data.delta) && data.index !== undefined) {
      const block = blocks[data.index] ?? { type: data.delta.type, index: data.index, text: '' };
      if (data.delta.type === 'text_delta') {
        block.type = 'text';
        block.text = (block.text ?? '') + (data.delta.text ?? '');
      } else if (data.delta.type === 'input_json_delta' && typeof data.delta.partial_json === 'string') {
        block.type = 'tool_use';
        block.input = (typeof block.input === 'string' ? block.input : '') + data.delta.partial_json;
      }
      blocks[data.index] = block;
    }
  }
  const content = blocks.filter(isObject);
  if (content.length > 0) semantic.content = content;
  return semantic;
}

function deriveGeminiSemantic(frames) {
  const semantic = {};
  const candidateFrames = [];
  for (const frame of frames) {
    const data = frameData(frame);
    if (!data) continue;
    if (data.usageMetadata !== undefined) semantic.usageMetadata = mergeUsage(semantic.usageMetadata ?? {}, data.usageMetadata);
    const present = Array.isArray(data.candidates) ? data.candidates.filter(isObject) : [];
    if (present.length > 0) candidateFrames.push(present);
  }

  const identityOf = (index) => `${typeof index}:${String(index)}`;
  const explicitIndexes = new Set();
  let multiElementArray = false;
  for (const present of candidateFrames) {
    if (present.length > 1) multiElementArray = true;
    for (const candidate of present) {
      if (candidate.index !== undefined) explicitIndexes.add(identityOf(candidate.index));
    }
  }
  const singleCandidateStream = !multiElementArray && explicitIndexes.size <= 1;
  const singleIdentity = explicitIndexes.size === 1 ? [...explicitIndexes][0] : 'indexless';
  const records = new Map();
  let lastTerminal = null;
  for (const present of candidateFrames) {
    for (const candidate of present) {
      const hasIndex = candidate.index !== undefined;
      const identity = singleCandidateStream ? singleIdentity : (hasIndex ? identityOf(candidate.index) : 'indexless');
      const assigned = singleCandidateStream || hasIndex;
      let record = records.get(identity);
      if (!record) {
        record = { assigned, parts: [], textParts: [], content: {} };
        records.set(identity, record);
      }
      if (record.index === undefined && hasIndex) record.index = candidate.index;
      if (isObject(candidate.content)) {
        for (const [key, value] of Object.entries(candidate.content)) {
          if (key !== 'parts') record.content[key] = value;
        }
        for (const part of Array.isArray(candidate.content.parts) ? candidate.content.parts : []) {
          record.parts.push(part);
          if (isObject(part) && typeof part.text === 'string' && part.thought !== true) record.textParts.push(part.text);
        }
      }
      if (candidate.finishReason !== undefined) lastTerminal = { candidate, record };
    }
  }
  if (lastTerminal) {
    semantic.candidate = lastTerminal.candidate;
    semantic.finishReason = lastTerminal.candidate.finishReason;
    if (lastTerminal.record.assigned && lastTerminal.record.textParts.length > 0) {
      semantic.text = lastTerminal.record.textParts.join('');
    }
  }
  // Text comes from the selected candidate. Only a stream with no terminal may
  // fall back to the single unambiguous observed candidate.
  const assignedWithText = [...records.values()].filter((record) => record.assigned && record.textParts.length > 0);
  if (!lastTerminal && assignedWithText.length === 1) semantic.text = assignedWithText[0].textParts.join('');

  const observed = [];
  for (const record of records.values()) {
    if (record.parts.length === 0 && Object.keys(record.content).length === 0) continue;
    const content = { ...record.content };
    if (record.parts.length > 0) content.parts = record.parts;
    observed.push({ ...(record.index === undefined ? {} : { index: record.index }), content });
  }
  if (observed.length > 0) semantic.candidates = observed;
  return semantic;
}

function hasJsonTerminalField(entryProtocol, data) {
  if (!isObject(data)) return false;
  if (entryProtocol === 'openai_chat') {
    return Array.isArray(data.choices) && data.choices.some((choice) => isNonEmptyString(choice?.finish_reason));
  }
  if (entryProtocol === 'responses') {
    return data.status === 'completed' || data.status === 'incomplete' || data.response?.status === 'completed' || data.response?.status === 'incomplete';
  }
  if (entryProtocol === 'anthropic') {
    return isNonEmptyString(data.stop_reason) || isNonEmptyString(data.delta?.stop_reason) || isNonEmptyString(data.message?.stop_reason);
  }
  if (entryProtocol === 'gemini') {
    return Array.isArray(data.candidates) && data.candidates.some((candidate) => isNonEmptyString(candidate?.finishReason));
  }
  return false;
}

function hasSseTerminal(entryProtocol, frames) {
  if (!Array.isArray(frames)) return false;
  for (const frame of frames) {
    if (!isObject(frame)) continue;
    const event = frame.event;
    const data = frame.data;
    if (entryProtocol === 'openai_chat') {
      if (hasJsonTerminalField(entryProtocol, data)) return true;
    } else if (entryProtocol === 'responses') {
      if (event === 'response.failed' || (isObject(data) && data.type === 'error')) continue;
      if ((event === 'response.completed' || event === 'response.incomplete') && (!isObject(data) || data.type === event || data.type === '')) return true;
      if (hasJsonTerminalField(entryProtocol, data)) return true;
    } else if (entryProtocol === 'anthropic') {
      if (event === 'message_stop' && (data === '' || data === undefined || (isObject(data) && data.type === 'message_stop'))) return true;
    } else if (entryProtocol === 'gemini') {
      if (hasJsonTerminalField(entryProtocol, data)) return true;
    }
  }
  return false;
}

/**
 * Return true only when the client body carries the protocol's semantic
 * terminal. Terminals come from parsed JSON fields/events only; marker text
 * inside content, provider error frames, malformed JSON, and stale/truncated
 * streams never prove completion.
 */
export function findSemanticTerminal(entryProtocol, parsed, bodyText) {
  if (!SUPPORTED_PROTOCOLS.includes(entryProtocol)) return false;

  if (typeof bodyText === 'string' && bodyText.length > 0 && looksLikeSseText(bodyText)) {
    return hasSseTerminal(entryProtocol, parseSse(bodyText));
  }
  if (typeof bodyText === 'string' && bodyText.length > 0) {
    const parsedBody = tryParseJson(bodyText);
    if (parsedBody !== null && hasJsonTerminalField(entryProtocol, parsedBody)) return true;
  }
  return isObject(parsed) && hasJsonTerminalField(entryProtocol, parsed);
}
