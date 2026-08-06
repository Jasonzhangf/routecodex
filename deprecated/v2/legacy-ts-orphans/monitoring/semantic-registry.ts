import type { SemanticSnapshotInput } from './semantic-tracker.js';
import { defaultSummary } from './semantic-tracker.js';

export type NamedSemanticSelector = (payload: unknown, snapshot: SemanticSnapshotInput) => unknown;
export type NamedSemanticSummary = (value: unknown) => string | null;
export type NamedSemanticChange = (args: {
  previous?: { value: unknown };
  current?: { value: unknown };
}) => string | null;
export type NamedSemanticNormalizer = (value: unknown) => unknown;
export type NamedSemanticTransform = (value: unknown, snapshot: SemanticSnapshotInput) => unknown;

// ===== Selectors =====
export const SELECTOR_REGISTRY: Record<string, NamedSemanticSelector> = {
  'messages.generic': selectMessages,
  'messages.system': selectSystemMessages,
  'toolCalls.fromMessages': selectToolCallsFromMessages,
  'toolCalls.fromRequiredAction': selectToolCallsFromRequiredAction,
  'tools.list': selectTools,
  'content.primary': extractPrimaryContent,
  'content.responses': extractResponsesContent,
  'route.target': selectRouteTarget,
  'route.model': selectModelIdentifier,
  'provider.system': selectProviderSystem
};

// ===== Summaries =====
export const SUMMARY_REGISTRY: Record<string, NamedSemanticSummary> = {
  messagesByRole: summarizeMessages,
  systemInstructions: summarizeSystemInstructions,
  toolCalls: summarizeToolCalls,
  toolDefinitions: summarizeToolDefinitions,
  requiredAction: summarizeRequiredAction,
  contentPreview: summarizeContent,
  routeTarget: summarizeRouteTarget,
  modelId: summarizeModelId,
  usageMetrics: summarizeUsage,
  toolResults: summarizeToolResults
};

// ===== Change descriptors =====
export const CHANGE_REGISTRY: Record<string, NamedSemanticChange> = {
  toolCallsDelta: describeToolCallsDelta,
  contentLengthDelta: describeContentDelta,
  systemInstructionDelta: describeSystemInstructionDelta
};

export const NORMALIZER_REGISTRY: Record<string, NamedSemanticNormalizer> = {
  systemMessages: normalizeSystemMessages
};

export const TRANSFORM_REGISTRY: Record<string, NamedSemanticTransform> = {};

function selectMessages(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.messages)) {
    return record.messages;
  }
  if (record.body && typeof record.body === 'object' && Array.isArray((record.body as Record<string, unknown>).messages)) {
    return (record.body as Record<string, unknown>).messages;
  }
  return undefined;
}

function selectSystemMessages(payload: unknown): unknown {
  const messages = selectMessages(payload);
  if (!Array.isArray(messages)) {
    return undefined;
  }
  const systems = (messages as unknown[]).filter((message) => {
    if (!message || typeof message !== 'object') {
      return false;
    }
    const role = (message as Record<string, unknown>).role;
    return typeof role === 'string' && role.toLowerCase() === 'system';
  });
  if (systems.length) {
    return systems;
  }
  const reminders = extractSystemReminderMessages(messages as unknown[]);
  return reminders.length ? reminders : undefined;
}

function selectToolCallsFromMessages(payload: unknown): unknown {
  const messages = selectMessages(payload);
  if (!Array.isArray(messages)) {
    return undefined;
  }
  const collected: unknown[] = [];
  for (const msg of messages) {
    if (msg && typeof msg === 'object') {
      const toolCalls = (msg as Record<string, unknown>).tool_calls;
      if (Array.isArray(toolCalls)) {
        collected.push(...toolCalls);
      }
    }
  }
  return collected.length ? collected : undefined;
}

function selectToolCallsFromRequiredAction(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const requiredAction = record.required_action;
  if (!requiredAction || typeof requiredAction !== 'object') {
    return undefined;
  }
  const sto = (requiredAction as Record<string, unknown>).submit_tool_outputs;
  if (!sto || typeof sto !== 'object') {
    return undefined;
  }
  const toolCalls = (sto as Record<string, unknown>).tool_calls;
  return Array.isArray(toolCalls) ? toolCalls : undefined;
}

function selectTools(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.tools)) {
    return record.tools;
  }
  if (record.body && typeof record.body === 'object') {
    const bodyTools = (record.body as Record<string, unknown>).tools;
    if (Array.isArray(bodyTools)) {
      return bodyTools;
    }
  }
  if (record.data && typeof record.data === 'object') {
    const dataTools = (record.data as Record<string, unknown>).tools;
    if (Array.isArray(dataTools)) {
      return dataTools;
    }
  }
  return undefined;
}

function extractResponsesContent(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === 'string') {
    return record.output_text;
  }
  const output = record.output;
  if (Array.isArray(output)) {
    const text = output.find((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).content === 'string');
    if (text && typeof (text as Record<string, unknown>).content === 'string') {
      return (text as Record<string, unknown>).content;
    }
  }
  return undefined;
}

function extractPrimaryContent(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.content === 'string') {
    return record.content;
  }
  if (Array.isArray(record.content)) {
    const textSegment = record.content.find(
      (segment) => segment && typeof segment === 'object' && typeof (segment as Record<string, unknown>).text === 'string'
    );
    if (textSegment && typeof (textSegment as Record<string, unknown>).text === 'string') {
      return (textSegment as Record<string, unknown>).text;
    }
  }
  const choices = record.choices;
  if (Array.isArray(choices)) {
    const first = choices[0];
    if (first && typeof first === 'object') {
      const msg = (first as Record<string, unknown>).message;
      if (msg && typeof msg === 'object') {
        if (typeof (msg as Record<string, unknown>).content === 'string') {
          return (msg as Record<string, unknown>).content;
        }
        const msgContent = (msg as Record<string, unknown>).content;
        if (Array.isArray(msgContent)) {
          const textPart = msgContent.find(
            (part) => part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
          );
          if (textPart && typeof (textPart as Record<string, unknown>).text === 'string') {
            return (textPart as Record<string, unknown>).text;
          }
        }
      }
    }
  }
  return undefined;
}

function selectRouteTarget(payload: unknown, snapshot: SemanticSnapshotInput): unknown {
  if (payload && typeof payload === 'object' && (payload as Record<string, unknown>).target) {
    const target = (payload as Record<string, unknown>).target;
    if (target && typeof target === 'object') {
      return target;
    }
  }
  const metadata =
    snapshot.metadata && typeof snapshot.metadata === 'object'
      ? (snapshot.metadata as Record<string, unknown>)
      : undefined;
  if (metadata) {
    const metaTarget = metadata.target;
    if (metaTarget && typeof metaTarget === 'object') {
      return metaTarget;
    }
  }
  return undefined;
}

function selectModelIdentifier(payload: unknown, snapshot: SemanticSnapshotInput): unknown {
  if (payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).model === 'string') {
    return (payload as Record<string, unknown>).model;
  }
  if (payload && typeof payload === 'object') {
    const target = (payload as Record<string, unknown>).target;
    if (target && typeof target === 'object') {
      const resolved = resolveModelFromTarget(target as Record<string, unknown>);
      if (resolved) {
        return resolved;
      }
    }
  }
  const metadata =
    snapshot.metadata && typeof snapshot.metadata === 'object'
      ? (snapshot.metadata as Record<string, unknown>)
      : undefined;
  if (metadata) {
    if (typeof metadata.model === 'string') {
      return metadata.model;
    }
    const metaTarget = metadata.target;
    if (metaTarget && typeof metaTarget === 'object') {
      const resolved = resolveModelFromTarget(metaTarget as Record<string, unknown>);
      if (resolved) {
        return resolved;
      }
    }
  }
  return undefined;
}

function selectProviderSystem(payload: unknown, snapshot: SemanticSnapshotInput): unknown {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.system === 'string' || Array.isArray(record.system)) {
      return record.system;
    }
    if (Array.isArray(record.messages)) {
      return selectSystemMessages(record);
    }
  }
  const metadata =
    snapshot.metadata && typeof snapshot.metadata === 'object'
      ? (snapshot.metadata as Record<string, unknown>)
      : {};
  return selectSystemMessages(metadata);
}

function summarizeMessages(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return defaultSummary(value);
  }
  const roles: Record<string, number> = {};
  let toolCalls = 0;
  for (const msg of value) {
    if (!msg || typeof msg !== 'object') {
      continue;
    }
    const msgRecord = msg as Record<string, unknown>;
    const role = typeof msgRecord.role === 'string' ? msgRecord.role : 'unknown';
    roles[role] = (roles[role] ?? 0) + 1;
    const tc = msgRecord.tool_calls;
    if (Array.isArray(tc)) {
      toolCalls += tc.length;
    }
  }
  const roleSummary = Object.entries(roles)
    .map(([role, count]) => `${role}:${count}`)
    .join(', ');
  return `messages=${value.length}${roleSummary ? ` (${roleSummary})` : ''}${toolCalls ? ` tool_calls=${toolCalls}` : ''}`;
}

function summarizeToolCalls(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return value === undefined ? null : defaultSummary(value);
  }
  const labels = value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return 'unknown';
      }
      const fn = (item as Record<string, unknown>).function;
      if (fn && typeof fn === 'object' && typeof (fn as Record<string, unknown>).name === 'string') {
        return (fn as Record<string, unknown>).name as string;
      }
      return (item as Record<string, unknown>).type && typeof (item as Record<string, unknown>).type === 'string'
        ? ((item as Record<string, unknown>).type as string)
        : 'unknown';
    })
    .slice(0, 4)
    .join(', ');
  const suffix = value.length > 4 ? '…' : '';
  return `tool_calls=${value.length}${labels ? ` [${labels}${suffix}]` : ''}`;
}

function summarizeToolDefinitions(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const names = new Set<string>();
  for (const tool of value) {
    const name = extractToolName(tool);
    if (name) {
      names.add(name);
    }
  }
  const list = Array.from(names);
  return `tools=${value.length}${list.length ? ` [${list.join(', ')}]` : ''}`;
}

function extractToolName(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  if (record.function && typeof record.function === 'object') {
    const fn = record.function as Record<string, unknown>;
    if (typeof fn.name === 'string' && fn.name.trim().length) {
      return fn.name.trim();
    }
  }
  if (typeof record.name === 'string' && record.name.trim().length) {
    return record.name.trim();
  }
  return undefined;
}

function summarizeSystemInstructions(value: unknown): string | null {
  if (!value) {
    return null;
  }
  const list = normalizeSystemMessages(value);
  const count = Array.isArray(list) ? list.length : 0;
  if (!count) {
    return null;
  }
  const preview = list[0]?.content;
  if (typeof preview === 'string') {
    const trimmed = preview.trim();
    if (trimmed.length) {
      return `system=${count} first="${trimmed.slice(0, 40)}${trimmed.length > 40 ? '…' : ''}"`;
    }
  }
  return `system=${count}`;
}

function summarizeRequiredAction(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return value === undefined ? null : defaultSummary(value);
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : 'unknown';
  if (type !== 'submit_tool_outputs') {
    return `type=${type}`;
  }
  const sto = record.submit_tool_outputs;
  let tc = 0;
  if (sto && typeof sto === 'object') {
    const stoRecord = sto as Record<string, unknown>;
    const toolCalls = stoRecord.tool_calls;
    if (Array.isArray(toolCalls)) {
      tc = toolCalls.length;
    }
  }
  return `type=submit_tool_outputs tool_calls=${tc}`;
}

function summarizeContent(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.length > 160 ? `${value.slice(0, 140)}…` : value;
  }
  return value === undefined ? null : defaultSummary(value);
}

function summarizeRouteTarget(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return value === undefined ? null : defaultSummary(value);
  }
  const record = value as Record<string, unknown>;
  const provider = typeof record.providerKey === 'string' ? record.providerKey : typeof record.provider === 'string' ? record.provider : undefined;
  const model = typeof record.clientModelId === 'string' ? record.clientModelId : typeof record.model === 'string' ? record.model : undefined;
  const route = typeof record.routeName === 'string' ? record.routeName : undefined;
  const parts = [];
  if (provider) {
    parts.push(provider);
  }
  if (model) {
    parts.push(`model=${model}`);
  }
  if (route) {
    parts.push(`route=${route}`);
  }
  return parts.length ? parts.join(' ') : defaultSummary(value);
}

function summarizeModelId(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? `model=${trimmed}` : '(empty string)';
  }
  return value === undefined ? null : defaultSummary(value);
}

function summarizeUsage(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return value === undefined ? null : defaultSummary(value);
  }
  const record = value as Record<string, unknown>;
  const prompt = pickNumber(record, ['prompt_tokens', 'input_tokens']);
  const completion = pickNumber(record, ['completion_tokens', 'output_tokens']);
  const total = pickNumber(record, ['total_tokens']);
  const promptDetails =
    record.prompt_tokens_details && typeof record.prompt_tokens_details === 'object'
      ? (record.prompt_tokens_details as Record<string, unknown>)
      : undefined;
  const cached = promptDetails ? pickNumber(promptDetails, ['cached_tokens']) : undefined;
  const parts: string[] = [];
  if (prompt !== undefined) {
    parts.push(`prompt=${prompt}`);
  }
  if (completion !== undefined) {
    parts.push(`completion=${completion}`);
  }
  if (total !== undefined) {
    parts.push(`total=${total}`);
  }
  if (cached !== undefined) {
    parts.push(`cached=${cached}`);
  }
  return parts.length ? parts.join(' ') : defaultSummary(value);
}

function summarizeToolResults(value: unknown): string | null {
  const outputs = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).tool_outputs)
      ? ((value as Record<string, unknown>).tool_outputs as unknown[])
      : null;
  if (!outputs) {
    return value === undefined ? null : defaultSummary(value);
  }
  if (!outputs.length) {
    return 'results=0';
  }
  let errors = 0;
  const previews: string[] = [];
  outputs.forEach((entry) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const record = entry as Record<string, unknown>;
    const output = typeof record.output === 'string' ? record.output : typeof record.content === 'string' ? record.content : null;
    const isError =
      record.is_error === true ||
      (typeof record.status === 'string' && record.status.toLowerCase() === 'error') ||
      (typeof output === 'string' && output.includes('<tool_use_error>'));
    if (isError) {
      errors += 1;
    }
    if (output && previews.length < 2) {
      const trimmed = output.trim().replace(/\s+/g, ' ');
      if (trimmed) {
        previews.push(trimmed.slice(0, 60));
      }
    }
  });
  const parts = [`results=${outputs.length}`];
  if (errors) {
    parts.push(`errors=${errors}`);
  }
  if (previews.length) {
    parts.push(`first="${previews.join(' / ')}${previews.length < outputs.length ? '…' : ''}"`);
  }
  return parts.join(' ');
}

function describeToolCallsDelta(args: { previous?: { value: unknown }; current?: { value: unknown } }): string | null {
  const prev = Array.isArray(args.previous?.value) ? args.previous?.value.length ?? 0 : 0;
  const curr = Array.isArray(args.current?.value) ? args.current?.value.length ?? 0 : 0;
  if (prev === curr) {
    return null;
  }
  return `tool_calls changed ${prev} → ${curr}`;
}

function describeContentDelta(args: { previous?: { value: unknown }; current?: { value: unknown } }): string | null {
  const prevLen = typeof args.previous?.value === 'string' ? args.previous?.value.length : 0;
  const currLen = typeof args.current?.value === 'string' ? args.current?.value.length : 0;
  if (!prevLen && currLen) {
    return `content added (${currLen} chars)`;
  }
  if (prevLen && !currLen) {
    return 'content dropped';
  }
  if (prevLen && currLen && prevLen !== currLen) {
    return `content length ${prevLen} → ${currLen}`;
  }
  return null;
}

function describeSystemInstructionDelta(args: { previous?: { value: unknown }; current?: { value: unknown } }): string | null {
  const prevCount = countSystemMessages(args.previous?.value);
  const currCount = countSystemMessages(args.current?.value);
  if (prevCount === currCount) {
    return null;
  }
  return `system_instructions ${prevCount} → ${currCount}`;
}

function countSystemMessages(value: unknown): number {
  const normalized = normalizeSystemMessages(value);
  return Array.isArray(normalized) ? normalized.length : 0;
}

function normalizeSystemMessages(value: unknown): Array<{ role: string; content: string }> {
  const entries: Array<{ role: string; content: string }> = [];
  const push = (content: unknown) => {
    if (typeof content === 'string') {
      const trimmed = content.trim();
      if (trimmed) {
        entries.push({ role: 'system', content: trimmed });
      }
      return;
    }
    if (content && typeof content === 'object') {
      const record = content as Record<string, unknown>;
      const role = typeof record.role === 'string' ? record.role : 'system';
      const text = typeof record.content === 'string' ? record.content : undefined;
      if (text && text.trim()) {
        entries.push({ role, content: text.trim() });
      }
    }
  };
  if (typeof value === 'string' || (value && typeof value === 'object' && 'role' in (value as Record<string, unknown>))) {
    push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => push(item));
  }
  return entries;
}

function extractSystemReminderMessages(messages: unknown[]): Array<{ role: string; content: string }> {
  const reminders: Array<{ role: string; content: string }> = [];
  messages.forEach((message) => {
    if (!message || typeof message !== 'object') {
      return;
    }
    const record = message as Record<string, unknown>;
    if (!Array.isArray(record.content)) {
      return;
    }
    record.content.forEach((segment) => {
      if (!segment || typeof segment !== 'object') {
        return;
      }
      const segRecord = segment as Record<string, unknown>;
      if (segRecord.type !== 'text' || typeof segRecord.text !== 'string') {
        return;
      }
      const extracted = extractSystemReminderText(segRecord.text);
      if (extracted) {
        reminders.push({ role: 'system', content: extracted });
      }
    });
  });
  return reminders;
}

function extractSystemReminderText(value: string): string | undefined {
  const marker = '<system-reminder>';
  const startIdx = value.indexOf(marker);
  if (startIdx === -1) {
    return undefined;
  }
  const endMarker = '</system-reminder>';
  const start = startIdx + marker.length;
  const endIdx = value.indexOf(endMarker, start);
  const slice = endIdx === -1 ? value.slice(start) : value.slice(start, endIdx);
  const trimmed = slice.trim();
  return trimmed || undefined;
}

function resolveModelFromTarget(target: Record<string, unknown>): string | undefined {
  if (typeof target.clientModelId === 'string' && target.clientModelId.trim()) {
    return target.clientModelId.trim();
  }
  if (typeof target.providerModelId === 'string' && target.providerModelId.trim()) {
    return target.providerModelId.trim();
  }
  if (typeof target.model === 'string' && target.model.trim()) {
    return target.model.trim();
  }
  return undefined;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === 'number') {
      return raw;
    }
  }
  return undefined;
}
