/**
 * Independent Grok provider family (Responses + cli-chat-proxy headers + wire sanitize).
 *
 * Black-box alignment with Grok Build / cli-chat-proxy:
 * - headers: Authorization (auth), X-XAI-Token-Auth, x-grok-model-override, client surface/version
 * - body: OpenAI Responses subset that ModelInput can deserialize (drop Codex-only items/tools)
 */

import type {
  ApplyRequestHeadersInput,
  BuildRequestBodyInput,
  ProviderFamilyProfile
} from '../profile-contracts.js';

const DEFAULT_CLIENT_SURFACE = 'grok-build';
const DEFAULT_CLIENT_VERSION = '0.2.93';

/** Input item types accepted by cli-chat-proxy ModelInput (OpenAI responses subset). */
const ALLOWED_INPUT_TYPES = new Set([
  'message',
  'function_call',
  'function_call_output'
]);

/** Tool types accepted on wire. */
const ALLOWED_TOOL_TYPES = new Set(['function']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assignHeader(headers: Record<string, string>, target: string, value: string): void {
  if (!value || !value.trim()) {
    return;
  }
  const lowered = target.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowered) {
      headers[key] = value;
      return;
    }
  }
  headers[target] = value;
}

function hasHeader(headers: Record<string, string>, target: string): boolean {
  const lowered = target.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lowered);
}

function readWireModel(input: ApplyRequestHeadersInput | BuildRequestBodyInput): string | undefined {
  const request = 'request' in input ? input.request : undefined;
  if (request && typeof request === 'object' && !Array.isArray(request)) {
    const model = (request as Record<string, unknown>).model;
    if (typeof model === 'string' && model.trim()) {
      return model.trim();
    }
  }
  const defaultBody = 'defaultBody' in input ? input.defaultBody : undefined;
  if (defaultBody && typeof defaultBody === 'object' && !Array.isArray(defaultBody)) {
    const model = (defaultBody as Record<string, unknown>).model;
    if (typeof model === 'string' && model.trim()) {
      return model.trim();
    }
  }
  const target = input.runtimeMetadata?.target;
  if (target && typeof target === 'object') {
    const modelId = typeof target.modelId === 'string' ? target.modelId.trim() : '';
    if (modelId) {
      return modelId;
    }
    const model = typeof target.model === 'string' ? target.model.trim() : '';
    if (model) {
      return model;
    }
  }
  return undefined;
}

function readClientVersion(input: ApplyRequestHeadersInput): string {
  const metadata = input.runtimeMetadata?.metadata;
  if (metadata && typeof metadata === 'object') {
    const fromMeta = (metadata as Record<string, unknown>).grokClientVersion
      ?? (metadata as Record<string, unknown>).clientVersion;
    if (typeof fromMeta === 'string' && fromMeta.trim()) {
      return fromMeta.trim();
    }
  }
  const env = process.env.GROK_CLIENT_VERSION || process.env.XAI_GROK_CLIENT_VERSION;
  if (typeof env === 'string' && env.trim()) {
    return env.trim();
  }
  return DEFAULT_CLIENT_VERSION;
}

function readClientSurface(input: ApplyRequestHeadersInput): string {
  const metadata = input.runtimeMetadata?.metadata;
  if (metadata && typeof metadata === 'object') {
    const fromMeta = (metadata as Record<string, unknown>).grokClientSurface
      ?? (metadata as Record<string, unknown>).clientSurface;
    if (typeof fromMeta === 'string' && fromMeta.trim()) {
      return fromMeta.trim();
    }
  }
  const env = process.env.GROK_CLIENT_SURFACE;
  if (typeof env === 'string' && env.trim()) {
    return env.trim();
  }
  return DEFAULT_CLIENT_SURFACE;
}

function readClientIdentifier(input: ApplyRequestHeadersInput): string | undefined {
  const metadata = input.runtimeMetadata?.metadata;
  if (metadata && typeof metadata === 'object') {
    const fromMeta = (metadata as Record<string, unknown>).grokClientIdentifier
      ?? (metadata as Record<string, unknown>).clientIdentifier;
    if (typeof fromMeta === 'string' && fromMeta.trim()) {
      return fromMeta.trim();
    }
  }
  const env = process.env.GROK_CLIENT_IDENTIFIER;
  if (typeof env === 'string' && env.trim()) {
    return env.trim();
  }
  return undefined;
}

function sanitizeContentPart(part: unknown): Record<string, unknown> | string | null {
  if (typeof part === 'string') {
    return part;
  }
  const row = asRecord(part);
  if (!row) {
    return null;
  }
  const type = typeof row.type === 'string' ? row.type : '';
  // Keep plain text parts only; drop images/files/unknown for ModelInput safety.
  if (type === 'input_text' || type === 'output_text' || type === 'text') {
    const text = typeof row.text === 'string' ? row.text : '';
    // Normalize to input_text for request history (Grok ModelInput accepts text content).
    return { type: 'input_text', text };
  }
  return null;
}

function sanitizeMessageItem(item: Record<string, unknown>): Record<string, unknown> | null {
  const role = typeof item.role === 'string' ? item.role : 'user';
  const content = item.content;
  if (typeof content === 'string') {
    return { type: 'message', role, content };
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => sanitizeContentPart(part))
      .filter((part): part is Record<string, unknown> | string => part !== null);
    if (parts.length === 0) {
      return null;
    }
    return { type: 'message', role, content: parts };
  }
  return null;
}

function sanitizeFunctionCall(item: Record<string, unknown>): Record<string, unknown> | null {
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  const callId = typeof item.call_id === 'string'
    ? item.call_id
    : (typeof item.callId === 'string' ? item.callId : '');
  if (!name || !callId) {
    return null;
  }
  let argumentsValue = item.arguments;
  if (argumentsValue !== undefined && typeof argumentsValue !== 'string') {
    try {
      argumentsValue = JSON.stringify(argumentsValue);
    } catch {
      argumentsValue = '{}';
    }
  }
  if (typeof argumentsValue !== 'string') {
    argumentsValue = '{}';
  }
  return {
    type: 'function_call',
    name,
    call_id: callId,
    arguments: argumentsValue
  };
}

function sanitizeFunctionCallOutput(item: Record<string, unknown>): Record<string, unknown> | null {
  const callId = typeof item.call_id === 'string'
    ? item.call_id
    : (typeof item.callId === 'string' ? item.callId : '');
  if (!callId) {
    return null;
  }
  let output = item.output;
  if (output !== undefined && typeof output !== 'string') {
    try {
      output = JSON.stringify(output);
    } catch {
      output = String(output);
    }
  }
  if (typeof output !== 'string') {
    output = '';
  }
  return {
    type: 'function_call_output',
    call_id: callId,
    output
  };
}

function sanitizeInputItem(item: unknown): Record<string, unknown> | null {
  const row = asRecord(item);
  if (!row) {
    return null;
  }
  // role-only message without type
  if (!row.type && typeof row.role === 'string') {
    return sanitizeMessageItem({ ...row, type: 'message' });
  }
  const type = typeof row.type === 'string' ? row.type : '';
  if (!ALLOWED_INPUT_TYPES.has(type)) {
    // Drop reasoning / custom_tool_call / custom_tool_call_output / item_reference / etc.
    return null;
  }
  if (type === 'message') {
    return sanitizeMessageItem(row);
  }
  if (type === 'function_call') {
    return sanitizeFunctionCall(row);
  }
  if (type === 'function_call_output') {
    return sanitizeFunctionCallOutput(row);
  }
  return null;
}

function sanitizeTools(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) {
    return undefined;
  }
  const out: unknown[] = [];
  for (const tool of tools) {
    const row = asRecord(tool);
    if (!row) {
      continue;
    }
    const type = typeof row.type === 'string' ? row.type : (typeof row.name === 'string' ? 'function' : '');
    if (!ALLOWED_TOOL_TYPES.has(type) && type !== '') {
      // drop custom / web_search / tool_search / apply_patch freeform
      continue;
    }
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name) {
      continue;
    }
    const parameters = row.parameters ?? row.input_schema ?? { type: 'object', properties: {} };
    const cleaned: Record<string, unknown> = {
      type: 'function',
      name,
      parameters
    };
    if (typeof row.description === 'string' && row.description.trim()) {
      cleaned.description = row.description;
    }
    out.push(cleaned);
  }
  return out;
}

/**
 * Sanitize Responses request body for cli-chat-proxy ModelInput compatibility.
 * Provider-local only — does not change Hub semantics.
 */
export function sanitizeGrokResponsesWireBody(defaultBody: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { ...defaultBody };

  // Never send internal metadata-like fields on provider wire.
  delete body.client_metadata;
  delete body.metadata;
  delete body.prompt_cache_key;
  delete body.include;

  // ModelInput: keep only supported input items.
  if (Array.isArray(body.input)) {
    const nextInput = body.input
      .map((item) => sanitizeInputItem(item))
      .filter((item): item is Record<string, unknown> => item !== null);
    body.input = nextInput.length > 0 ? nextInput : [{ type: 'message', role: 'user', content: 'continue' }];
  } else if (typeof body.input === 'string') {
    // string input is OK for EasyInputMessage path
  } else if (body.input !== undefined) {
    delete body.input;
  }

  // Tools: only function tools.
  if (body.tools !== undefined) {
    const tools = sanitizeTools(body.tools);
    if (tools && tools.length > 0) {
      body.tools = tools;
    } else {
      delete body.tools;
      if (body.tool_choice !== undefined) {
        delete body.tool_choice;
      }
    }
  }

  // grok-build rejects reasoningEffort / reasoning object on Responses wire.
  delete body.reasoning;
  delete body.reasoning_effort;
  delete body.reasoningEffort;

  // text.verbosity is OpenAI-specific; keep format only if present.
  const text = asRecord(body.text);
  if (text) {
    if (text.format && typeof text.format === 'object') {
      body.text = { format: text.format };
    } else {
      delete body.text;
    }
  }

  // Ensure model is wire model id when present.
  if (typeof body.model === 'string' && body.model.trim()) {
    body.model = body.model.trim();
  }

  if (body.stream === undefined) {
    body.stream = true;
  }

  return body;
}

export const grokFamilyProfile: ProviderFamilyProfile = {
  id: 'grok/default',
  providerFamily: 'grok',

  buildRequestBody(input: BuildRequestBodyInput) {
    const defaultBody = asRecord(input.defaultBody) || {};
    const sanitized = sanitizeGrokResponsesWireBody({ ...defaultBody });
    const model = readWireModel(input);
    if (model) {
      sanitized.model = model;
    }
    return sanitized;
  },

  applyRequestHeaders(input: ApplyRequestHeadersInput): Record<string, string> | undefined {
    const headers = { ...(input.headers || {}) };

    const model = readWireModel(input);
    if (model) {
      assignHeader(headers, 'x-grok-model-override', model);
    }

    if (!hasHeader(headers, 'X-XAI-Token-Auth')) {
      assignHeader(headers, 'X-XAI-Token-Auth', 'xai-grok-cli');
    }

    assignHeader(headers, 'x-grok-client-surface', readClientSurface(input));
    assignHeader(headers, 'x-grok-client-version', readClientVersion(input));

    const clientId = readClientIdentifier(input);
    if (clientId) {
      assignHeader(headers, 'x-grok-client-identifier', clientId);
    }

    const requestId =
      (typeof input.runtimeMetadata?.requestId === 'string' && input.runtimeMetadata.requestId.trim())
      || undefined;
    if (requestId && !hasHeader(headers, 'x-grok-req-id')) {
      assignHeader(headers, 'x-grok-req-id', requestId);
    }

    return headers;
  },

  applyStreamModeHeaders(input): Record<string, string> | undefined {
    const headers = { ...input.headers };
    if (input.wantsSse) {
      assignHeader(headers, 'Accept', 'text/event-stream');
    }
    return headers;
  }
};

/** @deprecated use grokFamilyProfile */
export const grokCliFamilyProfile = grokFamilyProfile;
