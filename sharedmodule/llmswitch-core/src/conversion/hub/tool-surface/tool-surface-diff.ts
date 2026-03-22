import type { JsonValue } from '../types/json.js';
import { isJsonObject, jsonClone } from '../types/json.js';

type CanonicalToolShape = {
  name: string;
  description?: string;
  parameters?: unknown;
};

export type CanonicalToolCallSignature = {
  id?: string;
  name: string;
  argsType?: 'string' | 'object' | 'other';
  argsLen?: number;
};

export type CanonicalToolResultSignature = {
  toolCallId?: string;
  contentLen?: number;
};

export type CanonicalToolHistorySignature = {
  toolCalls: CanonicalToolCallSignature[];
  toolResults: CanonicalToolResultSignature[];
};

function stableStringify(value: unknown): string {
  const normalize = (node: unknown): unknown => {
    if (node === null || typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      return node;
    }
    if (Array.isArray(node)) {
      return node.map((entry) => normalize(entry));
    }
    if (isJsonObject(node as JsonValue)) {
      const out: Record<string, unknown> = {};
      const keys = Object.keys(node).sort();
      for (const key of keys) {
        out[key] = normalize((node as Record<string, unknown>)[key]);
      }
      return out;
    }
    return node;
  };
  try {
    return JSON.stringify(normalize(value));
  } catch {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
}

function extractToolName(tool: unknown): string | undefined {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    return undefined;
  }
  const obj = tool as Record<string, unknown>;
  const fnNode =
    obj.function && typeof obj.function === 'object' && !Array.isArray(obj.function)
      ? (obj.function as Record<string, unknown>)
      : undefined;
  const nameCandidate = fnNode?.name ?? obj.name;
  if (typeof nameCandidate === 'string' && nameCandidate.trim().length) {
    return nameCandidate.trim();
  }
  const typeRaw = typeof obj.type === 'string' ? obj.type.trim().toLowerCase() : '';
  if (typeRaw === 'web_search' || typeRaw.startsWith('web_search')) {
    return 'web_search';
  }
  return undefined;
}

function extractToolSchema(tool: unknown): CanonicalToolShape | undefined {
  const name = extractToolName(tool);
  if (!name) return undefined;
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    return { name };
  }
  const obj = tool as Record<string, unknown>;
  const fnNode =
    obj.function && typeof obj.function === 'object' && !Array.isArray(obj.function)
      ? (obj.function as Record<string, unknown>)
      : undefined;
  const description =
    typeof fnNode?.description === 'string'
      ? fnNode.description
      : typeof obj.description === 'string'
        ? (obj.description as string)
        : undefined;
  const parameters =
    fnNode && Object.prototype.hasOwnProperty.call(fnNode, 'parameters')
      ? fnNode.parameters
      : Object.prototype.hasOwnProperty.call(obj, 'parameters')
        ? obj.parameters
        : Object.prototype.hasOwnProperty.call(obj, 'input_schema')
          ? obj.input_schema
          : undefined;
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    ...(parameters !== undefined ? { parameters } : {})
  };
}

function parseToolsForDiff(raw: unknown): Map<string, CanonicalToolShape> {
  const map = new Map<string, CanonicalToolShape>();
  if (!Array.isArray(raw)) {
    return map;
  }
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const obj = entry as Record<string, unknown>;
    const declarations = Array.isArray(obj.functionDeclarations) ? obj.functionDeclarations : undefined;
    if (declarations && declarations.length) {
      for (const decl of declarations) {
        const schema = extractToolSchema({ type: 'function', function: decl });
        if (schema && !map.has(schema.name)) {
          map.set(schema.name, schema);
        }
      }
      continue;
    }
    const schema = extractToolSchema(entry);
    if (schema && !map.has(schema.name)) {
      map.set(schema.name, schema);
    }
  }
  return map;
}

export function computeToolSchemaDiff(
  baselineTools: unknown,
  candidateTools: unknown
): { diffCount: number; diffHead: Array<Record<string, unknown>> } {
  const baseline = parseToolsForDiff(baselineTools);
  const candidate = parseToolsForDiff(candidateTools);
  const names = Array.from(new Set([...baseline.keys(), ...candidate.keys()])).sort();

  let diffCount = 0;
  const diffHead: Array<Record<string, unknown>> = [];
  const pushHead = (entry: Record<string, unknown>): void => {
    if (diffHead.length < 10) {
      diffHead.push(entry);
    }
  };

  for (const name of names) {
    const a = baseline.get(name);
    const b = candidate.get(name);
    if (!a && b) {
      diffCount += 1;
      pushHead({ name, kind: 'missing_in_baseline' });
      continue;
    }
    if (a && !b) {
      diffCount += 1;
      pushHead({ name, kind: 'missing_in_candidate' });
      continue;
    }
    if (!a || !b) {
      continue;
    }
    const aSig = stableStringify({ description: a.description, parameters: a.parameters });
    const bSig = stableStringify({ description: b.description, parameters: b.parameters });
    if (aSig !== bSig) {
      diffCount += 1;
      pushHead({
        name,
        kind: 'schema_mismatch',
        baseline: jsonClone(a as unknown as JsonValue),
        candidate: jsonClone(b as unknown as JsonValue)
      });
    }
  }

  return { diffCount, diffHead };
}

export function extractToolHistoryFromChatMessages(messages: unknown): CanonicalToolHistorySignature {
  const out: CanonicalToolHistorySignature = { toolCalls: [], toolResults: [] };
  if (!Array.isArray(messages)) return out;

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue;
    const record = msg as Record<string, unknown>;
    const role = typeof record.role === 'string' ? record.role.trim().toLowerCase() : '';

    if (role === 'assistant') {
      const toolCalls = Array.isArray((record as any).tool_calls) ? ((record as any).tool_calls as any[]) : [];
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== 'object') continue;
        const id = typeof (tc as any).id === 'string' && (tc as any).id.trim().length ? String((tc as any).id) : undefined;
        const fn = (tc as any).function;
        const name = typeof fn?.name === 'string' ? String(fn.name).trim() : '';
        const args = fn?.arguments;
        const argsType =
          typeof args === 'string' ? 'string' : args && typeof args === 'object' && !Array.isArray(args) ? 'object' : 'other';
        const argsLen = typeof args === 'string' ? args.length : undefined;
        if (name) {
          out.toolCalls.push({ id, name, argsType, argsLen });
        }
      }
    }

    if (role === 'tool') {
      const toolCallId =
        typeof (record as any).tool_call_id === 'string'
          ? String((record as any).tool_call_id).trim()
          : typeof (record as any).call_id === 'string'
            ? String((record as any).call_id).trim()
            : undefined;
      const content = (record as any).content;
      const contentLen = typeof content === 'string' ? content.length : undefined;
      out.toolResults.push({ toolCallId: toolCallId || undefined, contentLen });
    }
  }

  return out;
}

export function extractToolHistoryFromResponsesInputItems(input: unknown): CanonicalToolHistorySignature {
  const out: CanonicalToolHistorySignature = { toolCalls: [], toolResults: [] };
  if (!Array.isArray(input)) return out;
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const type = typeof rec.type === 'string' ? rec.type.trim().toLowerCase() : '';
    if (type === 'function_call') {
      const id =
        typeof (rec as any).call_id === 'string' && String((rec as any).call_id).trim().length
          ? String((rec as any).call_id).trim()
          : typeof rec.id === 'string' && rec.id.trim().length
            ? rec.id.trim()
            : undefined;
      const name = typeof rec.name === 'string' ? rec.name.trim() : '';
      const args = (rec as any).arguments;
      const argsType =
        typeof args === 'string' ? 'string' : args && typeof args === 'object' && !Array.isArray(args) ? 'object' : 'other';
      const argsLen = typeof args === 'string' ? args.length : undefined;
      if (name) {
        out.toolCalls.push({ id, name, argsType, argsLen });
      }
      continue;
    }
    if (type === 'function_call_output') {
      const toolCallId =
        typeof (rec as any).call_id === 'string' && String((rec as any).call_id).trim().length
          ? String((rec as any).call_id).trim()
          : typeof (rec as any).tool_call_id === 'string' && String((rec as any).tool_call_id).trim().length
            ? String((rec as any).tool_call_id).trim()
            : undefined;
      const output = (rec as any).output;
      const contentLen = typeof output === 'string' ? output.length : undefined;
      out.toolResults.push({ toolCallId: toolCallId || undefined, contentLen });
      continue;
    }
  }
  return out;
}

export function computeToolHistoryDiff(
  baseline: CanonicalToolHistorySignature,
  candidate: CanonicalToolHistorySignature
): { diffCount: number; diffHead: Array<Record<string, unknown>> } {
  let diffCount = 0;
  const diffs: Array<Record<string, unknown>> = [];
  const push = (entry: Record<string, unknown>) => {
    diffCount += 1;
    if (diffs.length < 10) diffs.push(entry);
  };

  const compareSeq = (a: any[], b: any[], kind: string) => {
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i += 1) {
      const ai = a[i];
      const bi = b[i];
      if (ai === undefined && bi !== undefined) {
        push({ kind, index: i, type: 'missing_in_baseline', candidate: bi });
        continue;
      }
      if (ai !== undefined && bi === undefined) {
        push({ kind, index: i, type: 'missing_in_candidate', baseline: ai });
        continue;
      }
      const aSig = stableStringify(ai);
      const bSig = stableStringify(bi);
      if (aSig !== bSig) {
        push({ kind, index: i, type: 'mismatch', baseline: ai, candidate: bi });
      }
    }
  };

  compareSeq(baseline.toolCalls, candidate.toolCalls, 'tool_calls');
  compareSeq(baseline.toolResults, candidate.toolResults, 'tool_results');

  return { diffCount, diffHead: diffs };
}
