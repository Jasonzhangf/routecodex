import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'node:stream';
import { extractProviderRuntimeMetadata } from '../core/runtime/provider-runtime-metadata.js';

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

function resolveMockSampleReqId(payload: unknown, body: Record<string, unknown> | undefined): string | undefined {
  const fromBody =
    body && typeof body.metadata === 'object' && body.metadata
      ? (body.metadata as Record<string, unknown>).mockSampleReqId
      : undefined;
  if (typeof fromBody === 'string' && fromBody.trim()) {
    return fromBody.trim();
  }
  if (payload && typeof payload === 'object') {
    const meta = (payload as Record<string, unknown>).metadata;
    const candidate =
      meta && typeof meta === 'object'
        ? (meta as Record<string, unknown>).mockSampleReqId
        : undefined;
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
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
    if (!Array.isArray(list)) {return;}
    list.forEach((item, index) => {
      if (!item || typeof item !== 'object') {return;}
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
    if (!entry || typeof entry !== 'object') {return;}
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
  const input = Array.isArray((body as Record<string, unknown>).input)
    ? ((body as Record<string, unknown>).input as Array<Record<string, unknown>>)
    : [];
  const issues: string[] = [];
  const isFc = (value: unknown): boolean => typeof value === 'string' && /^fc[_-]/i.test(value.trim());
  input.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {return;}
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
  if (!body || typeof body !== 'object') {return collected;}
  const input = Array.isArray((body as Record<string, unknown>).input)
    ? ((body as Record<string, unknown>).input as Array<Record<string, unknown>>)
    : [];
  input.forEach((entry) => {
    if (!entry || typeof entry !== 'object') {return;}
    const t = typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
    if (t !== 'function_call' && t !== 'function_call_output' && t !== 'tool_result' && t !== 'tool_message') {
      return;
    }
    const callId =
      (entry as Record<string, unknown>).call_id ||
      (entry as Record<string, unknown>).tool_call_id ||
      (entry as Record<string, unknown>).id;
    if (typeof callId === 'string' && callId.trim().length) {
      collected.add(callId.trim());
    }
  });
  return collected;
}

function validateCallIdExpectations(sample: MockSample, body: Record<string, unknown> | undefined, expected: string[] | undefined) {
  if (!expected || !expected.length) {return;}
  const actual = collectCallIdsFromInput(body);
  for (const target of expected) {
    if (!actual.has(target)) {
      const error = new Error(
        `Mock sample ${sample.reqId} 缺少期望的 call_id '${target}'`
      ) as MockRuntimeError & { status?: number };
      error.code = 'HTTP_400';
      (error as Record<string, unknown>).status = 400;
      throw error;
    }
  }
}

function validateApplyPatchToolSchema(sample: MockSample, body: Record<string, unknown> | undefined): void {
  if (!body || typeof body !== 'object') {
    return;
  }

  const tools = Array.isArray((body as Record<string, unknown>).tools)
    ? ((body as Record<string, unknown>).tools as unknown[])
    : [];
  const applyPatch = tools.find((tool) => {
    if (!tool || typeof tool !== 'object') {return false;}
    const record = tool as Record<string, unknown>;
    const fn = record.function;
    const fnName =
      fn && typeof fn === 'object' && !Array.isArray(fn) && typeof (fn as Record<string, unknown>).name === 'string'
        ? String((fn as Record<string, unknown>).name)
        : typeof record.name === 'string'
          ? record.name
          : undefined;
    return typeof fnName === 'string' && fnName.trim() === 'apply_patch';
  });
  if (!applyPatch) {
    return;
  }
  const applyPatchRecord = applyPatch as Record<string, unknown>;
  const applyPatchFn = applyPatchRecord.function;
  const params =
    applyPatchFn && typeof applyPatchFn === 'object' && !Array.isArray(applyPatchFn)
      ? (applyPatchFn as Record<string, unknown>).parameters
      : applyPatchRecord.parameters;
  const props = params && typeof params === 'object' ? (params as Record<string, unknown>).properties : undefined;

  const hasFreeformInputSchema = (): boolean => {
    const additionalProps = params && typeof params === 'object' ? (params as Record<string, unknown>).additionalProperties : undefined;
    const additionalOk = additionalProps === undefined || additionalProps === true;
    if (additionalOk && (!props || typeof props !== 'object')) {
      return true;
    }
    if (!props || typeof props !== 'object') {return false;}
    if (additionalOk && Object.keys(props as Record<string, unknown>).length === 0) {
      return true;
    }
    const hasInput = (props as Record<string, unknown>).input && typeof (props as Record<string, unknown>).input === 'object';
    const hasPatch = (props as Record<string, unknown>).patch && typeof (props as Record<string, unknown>).patch === 'object';
    // Be tolerant: some clients omit `required`, but still provide input/patch schema.
    return Boolean(hasInput || hasPatch);
  };

  const ok = hasFreeformInputSchema();
  if (!ok) {
    const summary = (() => {
      try {
        const fn =
          applyPatchRecord.function && typeof applyPatchRecord.function === 'object' && !Array.isArray(applyPatchRecord.function)
            ? (applyPatchRecord.function as Record<string, unknown>)
            : null;
        const nameCandidate =
          fn && typeof fn.name === 'string'
            ? fn.name
            : typeof applyPatchRecord.name === 'string'
              ? applyPatchRecord.name
              : 'apply_patch';
        const p = params && typeof params === 'object' ? params : null;
        return JSON.stringify({ name: nameCandidate, parameters: p }, null, 2);
      } catch {
        return '<unserializable>';
      }
    })();
    const error = new Error(
      `apply_patch schema 校验失败：freeform 模式要求 input/patch schema（sample=${sample.reqId}，当前：${summary}）`
    ) as MockRuntimeError & { status?: number };
    error.code = 'HTTP_400';
    (error as Record<string, unknown>).status = 400;
    throw error;
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
    const submitOutputs = Array.isArray((body as Record<string, unknown>).tool_outputs)
      ? ((body as Record<string, unknown>).tool_outputs as unknown[]).length > 0
      : false;
    const inputList = Array.isArray((body as Record<string, unknown>).input)
      ? ((body as Record<string, unknown>).input as Array<Record<string, unknown>>)
      : [];
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
  private sampleStatusCache: Map<string, number | null> = new Map();
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
    const modelCandidate =
      body && typeof body === 'object'
        ? (body as Record<string, unknown>).model
        : undefined;
    const runtimeMetadata =
      extractProviderRuntimeMetadata(payload) ??
      extractProviderRuntimeMetadata(body);
    const runtimeMockSampleReqId =
      typeof runtimeMetadata?.metadata?.mockSampleReqId === 'string'
        ? runtimeMetadata.metadata.mockSampleReqId
        : undefined;
    const mockSampleReqId =
      runtimeMockSampleReqId && runtimeMockSampleReqId.trim()
        ? runtimeMockSampleReqId.trim()
        : resolveMockSampleReqId(payload, body);
    const requestModel = parseModelFromRequestId(reqId, this.samples, entryHint);
    const runtimeModel =
      typeof runtimeMetadata?.target?.modelId === 'string'
        ? runtimeMetadata.target.modelId
        : typeof runtimeMetadata?.modelId === 'string'
          ? runtimeMetadata.modelId
          : undefined;
    const configuredModel =
      typeof this.model === 'string' && this.model.trim()
        ? this.model.trim()
        : '';
    const modelHint = typeof runtimeModel === 'string'
      ? runtimeModel.trim()
      : typeof requestModel === 'string' && requestModel.trim()
        ? requestModel.trim()
        : configuredModel && configuredModel !== 'unknown'
          ? configuredModel
          : typeof modelCandidate === 'string'
            ? modelCandidate.trim()
            : undefined;
    const sample =
      (mockSampleReqId ? this.sampleMap.get(mockSampleReqId) : undefined) ||
      this.sampleMap.get(reqId) ||
      await this.findFallback(reqId, entryHint, modelHint);
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
        (error as Record<string, unknown>).status = 400;
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
          (error as Record<string, unknown>).status = 400;
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
          (error as Record<string, unknown>).status = 400;
          throw error;
        }
      }
    }
    const respPath = path.join(MOCK_SAMPLES_DIR, sample.path, 'response.json');
    const resp = JSON.parse(await fs.readFile(respPath, 'utf-8')) as MockResponse;
    if (isValidationEnabled()) {
      validateCallIdExpectations(sample, body, resp.mockExpectations?.callIds);
    }
    validateApplyPatchToolSchema(sample, body);
    if (resp.mockExpectations) {
      delete resp.mockExpectations;
    }
    if (resp.body && typeof resp.body === 'object' && !Array.isArray(resp.body)) {
      const mode = (resp.body as Record<string, unknown>).mode;
      const errVal = (resp.body as Record<string, unknown>).error;
      if (mode === 'sse' && typeof errVal === 'string' && errVal.trim()) {
        const error = new Error(`Upstream SSE terminated: ${errVal.trim()}`) as MockRuntimeError & { status?: number };
        error.code = 'HTTP_502';
        (error as Record<string, unknown>).status = 502;
        throw error;
      }
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

  private async findFallback(reqId: string, entryHint?: string, modelHint?: string): Promise<MockSample | undefined> {
    if (!this.samples.length) {return undefined;}
    const parsed = parseRequestIdParts(reqId);
    const entryFromId = parsed?.entry;
    let entry = entryHint || entryFromId;
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
    const modelTrimmed = typeof modelHint === 'string' && modelHint.trim().length ? modelHint.trim() : '';
    const modelFiltered = modelTrimmed ? list.filter((s) => s.model === modelTrimmed) : [];
    let pool = modelFiltered.length ? modelFiltered : list.length ? list : this.samples;
    if (
      entryHint &&
      entryFromId &&
      entryHint !== entryFromId &&
      modelTrimmed &&
      pool === list &&
      !modelFiltered.length
    ) {
      const fallbackList = this.samples.filter((s) => s.entry === entryFromId);
      const fallbackFiltered = fallbackList.filter((s) => s.model === modelTrimmed);
      if (fallbackFiltered.length) {
        entry = entryFromId;
        pool = fallbackFiltered;
      }
    }
    if (parsed?.middle && modelTrimmed && pool.length > 1) {
      const providerIdFromId = resolveProviderIdFromId(parsed.middle, modelTrimmed);
      if (providerIdFromId) {
        const providerFiltered = pool.filter((s) => s.providerId === providerIdFromId);
        if (providerFiltered.length) {
          pool = providerFiltered;
        }
      }
    }
    if (pool.length > 1) {
      const healthy = await this.filterHealthySamples(pool);
      if (healthy.length) {
        pool = healthy;
      }
    }
    if (pool.length > 1) {
      const regression = pool.filter(
        (sample) => Array.isArray(sample.tags) && sample.tags.includes('regression')
      );
      if (regression.length) {
        pool = regression;
      }
    }
    pool.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return pool[0];
  }

  private async filterHealthySamples(pool: MockSample[]): Promise<MockSample[]> {
    const selected: MockSample[] = [];
    for (const sample of pool) {
      const status = await this.resolveSampleStatus(sample);
      if (typeof status === 'number' && status >= 400) {
        continue;
      }
      selected.push(sample);
    }
    return selected;
  }

  private async resolveSampleStatus(sample: MockSample): Promise<number | null> {
    if (this.sampleStatusCache.has(sample.reqId)) {
      return this.sampleStatusCache.get(sample.reqId) ?? null;
    }
    const responsePath = path.join(MOCK_SAMPLES_DIR, sample.path, 'response.json');
    try {
      const raw = await fs.readFile(responsePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const status = typeof parsed?.status === 'number' ? parsed.status : null;
      this.sampleStatusCache.set(sample.reqId, status);
      return status;
    } catch {
      this.sampleStatusCache.set(sample.reqId, null);
      return null;
    }
  }
}

function parseModelFromRequestId(
  requestId: string,
  samples: MockSample[],
  entryHint?: string
): string | undefined {
  const parsed = parseRequestIdParts(requestId);
  if (!parsed) {
    return undefined;
  }
  const entry = parsed.entry || entryHint;
  const middle = parsed.middle;
  const pool = entry
    ? samples.filter((sample) => sample.entry === entry)
    : samples;
  let best: string | undefined;
  for (const sample of pool) {
    const candidate = typeof sample.model === 'string' ? sample.model : '';
    if (!candidate) {
      continue;
    }
    if (middle === candidate || middle.endsWith(`-${candidate}`)) {
      if (!best || candidate.length > best.length) {
        best = candidate;
      }
    }
  }
  return best;
}

function parseRequestIdParts(
  requestId: string
): { entry: string; middle: string } | null {
  if (!requestId || typeof requestId !== 'string') {
    return null;
  }
  const match = requestId.match(
    /^(openai-responses|openai-chat|anthropic-messages|gemini-chat)-(.+)-(\d{8}T\d{9})-(\d{3})(:.*)?$/
  );
  if (!match) {
    return null;
  }
  return { entry: match[1], middle: match[2] };
}

function resolveProviderIdFromId(middle: string, model: string): string | undefined {
  if (!middle || !model) {
    return undefined;
  }
  const suffix = `-${model}`;
  if (!middle.endsWith(suffix)) {
    return undefined;
  }
  const providerId = middle.slice(0, -suffix.length).trim();
  return providerId || undefined;
}
