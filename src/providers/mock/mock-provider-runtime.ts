import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'node:stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const NAME_REGEX = /^[A-Za-z0-9_-]+$/;
const GENERIC_PROVIDER_TYPES = new Set(['openai', 'responses', 'anthropic', 'gemini']);

function resolveSamplesDirectory(): string {
  const override = String(process.env.ROUTECODEX_MOCK_SAMPLES_DIR || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(PROJECT_ROOT, override);
  }
  return path.join(PROJECT_ROOT, 'samples/mock-provider');
}

const MOCK_SAMPLES_DIR = resolveSamplesDirectory();
const REGISTRY_PATH = path.join(MOCK_SAMPLES_DIR, '_registry/index.json');

interface MockSample {
  reqId: string;
  entry: string;
  providerId: string;
  model: string;
  timestamp: string;
  path: string;
  tags: string[];
}

interface MockResponse {
  reqId: string;
  status?: number;
  body?: unknown;
  sseEvents?: { event?: string; data: string }[];
  error?: { status: number; body: { code?: string; message?: string } };
  mockExpectations?: { callIds?: string[] };
}

interface MockRuntimeError {
  code?: string;
  message?: string;
}

function isValidationEnabled(): boolean {
  const value = String(process.env.ROUTECODEX_MOCK_VALIDATE_NAMES || '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

function extractRequestBody(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const record = payload as Record<string, unknown> & { data?: unknown };
  if (record.data && typeof record.data === 'object') {
    return record.data as Record<string, unknown>;
  }
  return record;
}

function collectInvalidNames(body: Record<string, unknown> | undefined): Array<{ location: string; value: string }> {
  if (!body || typeof body !== 'object') {
    return [];
  }
  const failures: Array<{ location: string; value: string }> = [];
  const record = body as Record<string, unknown>;

  const check = (value: unknown, location: string) => {
    if (typeof value !== 'string' || !value.trim()) {
      return;
    }
      if (!NAME_REGEX.test(value)) {
        failures.push({ location, value });
      }
    };

  const visitList = (list: unknown, base: string) => {
    if (!Array.isArray(list)) return;
    list.forEach((item, index) => {
      if (!item || typeof item !== 'object') return;
      const entry = item as Record<string, unknown>;
      check(entry.name, `${base}[${index}].name`);
      if (entry.function && typeof entry.function === 'object') {
        check((entry.function as Record<string, unknown>).name, `${base}[${index}].function.name`);
      }
    });
  };

  visitList(record.input, 'input');
  visitList(record.tools, 'tools');

  const requiredAction = record.required_action as Record<string, unknown> | undefined;
  if (requiredAction && typeof requiredAction === 'object') {
    const submits = requiredAction.submit_tool_outputs as Record<string, unknown> | undefined;
    if (submits && typeof submits === 'object') {
      visitList(submits.tool_calls, 'required_action.tool_calls');
    }
  }

  return failures;
}

function collectMissingToolOutputs(body: Record<string, unknown> | undefined): string[] {
  if (!body || typeof body !== 'object') {
    return [];
  }
  const input = Array.isArray((body as Record<string, unknown>).input)
    ? ((body as Record<string, unknown>).input as Array<Record<string, unknown>>)
    : [];
  const missing: string[] = [];
  input.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
    if (type !== 'function_call_output' && type !== 'tool_result' && type !== 'tool_message') {
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(entry, 'output')) {
      missing.push(`input[${index}].output`);
    }
  });
  return missing;
}

function collectNonFcCallIds(body: Record<string, unknown> | undefined): string[] {
  if (!body || typeof body !== 'object') {
    return [];
  }
  const input = Array.isArray((body as any).input) ? ((body as any).input as Array<Record<string, unknown>>) : [];
  const issues: string[] = [];
  const isFc = (value: unknown): boolean => typeof value === 'string' && /^fc[_-]/i.test(value.trim());
  input.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
    if (type !== 'function_call' && type !== 'function_call_output' && type !== 'tool_result' && type !== 'tool_message') {
      return;
    }
    const idVal = typeof entry.id === 'string' ? entry.id : undefined;
    if (idVal && !isFc(idVal)) {
      issues.push(`input[${index}].id=${idVal}`);
    }
  });
  return issues;
}

function collectCallIdsFromInput(body: Record<string, unknown> | undefined): Set<string> {
  const collected = new Set<string>();
  if (!body || typeof body !== 'object') return collected;
  const input = Array.isArray((body as any).input) ? ((body as any).input as Array<Record<string, unknown>>) : [];
  input.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const t = typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
    if (t !== 'function_call' && t !== 'function_call_output' && t !== 'tool_result' && t !== 'tool_message') {
      return;
    }
    const callId =
      (entry as any).call_id ||
      (entry as any).tool_call_id ||
      (entry as any).id;
    if (typeof callId === 'string' && callId.trim().length) {
      collected.add(callId.trim());
    }
  });
  return collected;
}

function validateCallIdExpectations(sample: MockSample, body: Record<string, unknown> | undefined, expected: string[] | undefined) {
  if (!expected || !expected.length) return;
  const actual = collectCallIdsFromInput(body);
  for (const target of expected) {
    if (!actual.has(target)) {
      const error = new Error(
        `Mock sample ${sample.reqId} 缺少期望的 call_id '${target}'`
      ) as MockRuntimeError & { status?: number };
      error.code = 'HTTP_400';
      (error as any).status = 400;
      throw error;
    }
  }
}

function detectEntryHint(
  payload: { entryEndpoint?: string; endpoint?: string } | undefined,
  body: Record<string, unknown> | undefined
): string | undefined {
  const endpoint = typeof payload?.entryEndpoint === 'string' && payload.entryEndpoint.trim()
    ? payload.entryEndpoint.trim()
    : typeof payload?.endpoint === 'string' && payload.endpoint.trim()
      ? payload.endpoint.trim()
      : undefined;
  if (endpoint && endpoint.includes('submit_tool_outputs')) {
    return 'openai-responses.submit_tool_outputs';
  }
  if (body && typeof body === 'object') {
    const submitOutputs = Array.isArray((body as any).tool_outputs) && (body as any).tool_outputs.length > 0;
    const inputList = Array.isArray((body as any).input) ? ((body as any).input as Array<Record<string, unknown>>) : [];
    const hasOutputEntries = inputList.some((entry) => {
      const type = typeof entry?.type === 'string' ? entry.type.toLowerCase() : '';
      return type === 'function_call_output' || type === 'tool_result' || type === 'tool_message';
    });
    if (submitOutputs || hasOutputEntries) {
      return 'openai-responses.submit_tool_outputs';
    }
  }
  return undefined;
}

export class MockProviderRuntime {
  private samples: MockSample[] = [];
  private sampleMap: Map<string, MockSample> = new Map();
  private providerId: string;
  private model: string;

  constructor(config: { providerId: string; model: string }) {
    this.providerId = config.providerId;
    this.model = config.model;
  }

  async initialize(): Promise<void> {
    const registry = JSON.parse(await fs.readFile(REGISTRY_PATH, 'utf-8'));
    const providerLabel = this.providerId || 'unknown';
    const providerKey = providerLabel.toLowerCase();
    const providerIsGeneric = providerKey === 'unknown' || GENERIC_PROVIDER_TYPES.has(providerKey);
    const modelLabel = this.model || 'unknown';
    this.samples = registry.samples.filter((s: MockSample) => {
      const providerMatch =
        providerIsGeneric ||
        s.providerId === providerLabel ||
        s.providerId.startsWith(`${providerLabel}.`);
      const modelMatch = modelLabel === 'unknown' || s.model === modelLabel;
      return providerMatch && modelMatch;
    });
    for (const s of this.samples) {
      this.sampleMap.set(s.reqId, s);
    }
    console.log(`[MockProviderRuntime] Samples loaded: ${this.samples.length} (providerId=${providerLabel}, model=${modelLabel})`);
  }

  async process(payload: { entryEndpoint?: string; requestId?: string; data?: unknown }): Promise<unknown> {
    const reqId = typeof payload?.requestId === 'string' && payload.requestId
      ? payload.requestId
      : 'unknown';
    const body = extractRequestBody(payload);
    const entryHint = detectEntryHint(payload, body);
    const sample = this.sampleMap.get(reqId) || this.findFallback(reqId, entryHint);
    if (!sample) {
      const err: MockRuntimeError = {
        code: 'MOCK_NOT_FOUND',
        message: `No mock sample found for reqId ${reqId}`
      };
      const error = new Error(err.message) as any;
      error.code = err.code;
      error.metadata = { requestId: reqId, providerKey: `${this.providerId}.${this.model}` };
      throw error;
    }
    if (isValidationEnabled()) {
      const invalid = collectInvalidNames(body);
      if (invalid.length) {
        const first = invalid[0];
        const error = new Error(
          `Invalid '${first.location}': string does not match pattern. Expected a string that matches the pattern '^[A-Za-z0-9_-]+$'.`
        ) as MockRuntimeError & { status?: number };
        error.code = 'HTTP_400';
        (error as any).status = 400;
        throw error;
      }
      const shouldCheckOutputs = sample.entry === 'openai-responses' || (Array.isArray(sample.tags) && sample.tags.includes('missing_output'));
      if (shouldCheckOutputs) {
        const missingOutputs = collectMissingToolOutputs(body);
        if (missingOutputs.length) {
          const error = new Error(
            `Missing required parameter(s): ${missingOutputs.join(', ')}`
          ) as MockRuntimeError & { status?: number };
          error.code = 'HTTP_400';
          (error as any).status = 400;
          throw error;
        }
      }
      const requireFcStyle = Array.isArray(sample.tags) && sample.tags.includes('require_fc_call_ids');
      if (requireFcStyle) {
        const invalidIds = collectNonFcCallIds(body);
        if (invalidIds.length) {
          const error = new Error(
            `Invalid 'input[*].id': requires fc_* prefix (${invalidIds.join(', ')})`
          ) as MockRuntimeError & { status?: number };
          error.code = 'HTTP_400';
          (error as any).status = 400;
          throw error;
        }
      }
    }
    const respPath = path.join(MOCK_SAMPLES_DIR, sample.path, 'response.json');
    const resp = JSON.parse(await fs.readFile(respPath, 'utf-8')) as MockResponse;
    if (isValidationEnabled()) {
      validateCallIdExpectations(sample, body, resp.mockExpectations?.callIds);
    }
    if (resp.mockExpectations) {
      delete (resp as any).mockExpectations;
    }
    if (resp.error) {
      const err: MockRuntimeError = {
        code: resp.error.body?.code || 'MOCK_ERROR',
        message: resp.error.body?.message || 'Mock error',
      };
      const error = new Error(err.message) as any;
      error.code = err.code;
      error.metadata = { requestId: reqId, providerKey: `${this.providerId}.${this.model}` };
      error.status = resp.error.status;
      throw error;
    }
    if (resp.sseEvents && Array.isArray(resp.sseEvents)) {
      const lines: string[] = [];
      for (const ev of resp.sseEvents) {
        if (ev.event) {
          lines.push(`event: ${ev.event}`);
        }
        lines.push(`data: ${ev.data}`);
        lines.push('');
      }
      lines.push('data: [DONE]');
      return {
        status: resp.status || 200,
        data: { __sse_responses: Readable.from(lines.join('\n')) },
        headers: { 'content-type': 'text/event-stream; charset=utf-8' }
      };
    }
    return {
      status: resp.status || 200,
      data: resp.body || {},
      headers: { 'content-type': 'application/json; charset=utf-8' }
    };
  }

  private findFallback(reqId: string, entryHint?: string): MockSample | undefined {
    if (!this.samples.length) return undefined;
    let entry = entryHint;
    if (!entry) {
      if (reqId.startsWith('openai-responses.submit_tool_outputs-')) {
        entry = 'openai-responses.submit_tool_outputs';
      } else if (reqId.startsWith('openai-responses-')) {
        entry = 'openai-responses';
      } else if (reqId.startsWith('anthropic-messages-')) {
        entry = 'anthropic-messages';
      } else if (reqId.startsWith('gemini-chat-')) {
        entry = 'gemini-chat';
      }
    }
    if (!entry) {
      entry = reqId.split('-')[0];
    }
    const list = this.samples.filter((s) => s.entry === entry);
    const pool = list.length ? list : this.samples;
    pool.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return pool[0];
  }
}
