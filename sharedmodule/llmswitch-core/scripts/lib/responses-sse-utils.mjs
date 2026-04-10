import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
export const DEFAULT_EVENTS_DIR = path.join(
  os.homedir(),
  '.routecodex',
  'codex-samples',
  'openai-responses',
  'lmstudio-golden'
);

export async function resolveEventsFilePath(candidatePath) {
  if (candidatePath) {
    const abs = path.isAbsolute(candidatePath) ? candidatePath : path.resolve(candidatePath);
    await assertFileExists(abs);
    return abs;
  }
  const fallback = await findLatestEventsFile(DEFAULT_EVENTS_DIR);
  if (!fallback) {
    throw new Error(`No Responses SSE samples found under ${DEFAULT_EVENTS_DIR}`);
  }
  return fallback;
}

export async function loadResponsesEvents(eventsPath) {
  const text = await fs.readFile(eventsPath, 'utf-8');
  const lines = text.split('\n');
  const events = [];
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const event = parsed?.event ?? parsed;
      if (event && typeof event === 'object') {
        events.push(event);
      }
    } catch (error) {
      console.warn(`[responses-sse-utils] Failed to parse line: ${line.slice(0, 80)}`, error);
    }
  }
  if (!events.length) {
    throw new Error(`No SSE events found in ${eventsPath}`);
  }
  return events;
}

export function deriveModelFromEvents(events, fallback = 'unknown') {
  for (const ev of events) {
    const model = ev?.response?.model ?? ev?.response?.data?.model;
    if (typeof model === 'string' && model.trim()) {
      return model;
    }
  }
  return fallback;
}

export function deriveResponseIdFromEvents(events, fallback = '') {
  for (const ev of events) {
    const respId = ev?.response?.id;
    if (typeof respId === 'string' && respId.trim()) {
      return respId;
    }
  }
  return fallback || `resp_${Date.now()}`;
}

export async function convertEventsToResponsesJson(events, options) {
  const model = options?.model || deriveModelFromEvents(events);
  const requestId = options?.requestId || deriveResponseIdFromEvents(events);
  const response = extractResponseFromEvents(events, model);
  return {
    response,
    meta: {
      eventCount: events.length,
      requestId,
      model: response.model || model
    }
  };
}

async function findLatestEventsFile(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.events.ndjson')) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const stats = await fs.stat(fullPath);
        candidates.push({ path: fullPath, mtime: stats.mtimeMs });
      } catch {
        // ignore stat errors
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0]?.path ?? null;
  } catch (error) {
    console.warn(`[responses-sse-utils] Unable to scan ${dir}:`, error?.message || error);
    return null;
  }
}

async function assertFileExists(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
}

function extractResponseFromEvents(events, fallbackModel) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === 'response.completed' && event.response) {
      return JSON.parse(JSON.stringify(event.response));
    }
  }
  return aggregateResponsesFromEvents(events, fallbackModel);
}

function aggregateResponsesFromEvents(events, fallbackModel) {
  const state = {
    id: deriveResponseIdFromEvents(events, `resp_${Date.now()}`),
    model: fallbackModel,
    created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress',
    usage: undefined,
    outputTextParts: [],
    toolCalls: []
  };

  for (const ev of events) {
    const data = ev || {};
    if (ev.type === 'response.created' && data.response) {
      state.id = data.response.id || state.id;
      state.model = data.response.model || state.model;
      state.created_at = data.response.created_at || state.created_at;
      state.status = data.response.status || state.status;
      continue;
    }
    if (ev.type === 'response.completed' && data.response) {
      const resp = data.response;
      if (!state.model) state.model = resp.model;
      if (!state.usage) state.usage = resp.usage;
      state.status = resp.status || 'completed';
      if (Array.isArray(resp.output) && resp.output.length) {
        return JSON.parse(JSON.stringify(resp));
      }
      continue;
    }
    if (ev.type === 'response.output_text.delta') {
      const delta = data.delta;
      if (typeof delta === 'string') {
        state.outputTextParts.push(delta);
      }
      continue;
    }
    if (ev.type === 'response.function_call_arguments.done') {
      state.toolCalls.push({
        id: data.item_id || `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: {
          name: data.name || 'tool',
          arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {})
        }
      });
      continue;
    }
    if (ev.type === 'response.completed' && data.response?.usage) {
      state.usage = data.response.usage;
    }
  }

  const response = {
    id: state.id,
    object: 'response',
    created_at: state.created_at,
    model: state.model || 'unknown',
    status: state.toolCalls.length ? 'in_progress' : 'completed',
    output: [],
    output_text: state.outputTextParts.join('') || undefined
  };

  if (state.toolCalls.length) {
    response.required_action = {
      type: 'submit_tool_outputs',
      submit_tool_outputs: {
        tool_calls: state.toolCalls
      }
    };
  }
  if (state.usage) {
    response.usage = state.usage;
  }
  return response;
}
