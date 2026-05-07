/**
 * MiMo Web Provider — Response-side tool-call harvest
 *
 * Parses tool-call XML/JSON blocks from model text output and converts
 * them into structured {name, input, callId} objects.
 * Ported from mimo2api parser.ts (MiMo native + named JSON formats).
 *
 * ONLY used inside mimoweb compat layer; never leaks into Hub Pipeline.
 */

import { cleanInvisibleChars, parseJsonSafely, parseXmlParams, extractName } from './mimoweb-xml-parser.js';

/** Structured tool call extracted from model text. */
export interface HarvestedToolCall {
  name: string;
  input: Record<string, unknown>;
  callId: string;
}

const MAX_TOOL_CALLS = 50;

function generateCallId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return 'toolu_mimo_' + ts + rand;
}

// Use charCode helpers to avoid shell escaping issues with XML tags
const LT = String.fromCharCode(60); // <
const GT = String.fromCharCode(62); // >
const SL = String.fromCharCode(47); // /
const DQ = String.fromCharCode(34); // "
const BS = String.fromCharCode(92); // backslash

// Build regex for tool_call blocks using RegExp constructor
const toolCallBlockRe = new RegExp(
  LT + 'tool_?call(?:\\s+(?:name|id)=' + DQ + '([^' + DQ + ']+)' + DQ + ')?\\s*' + GT
  + '([\\s\\S]*?)'
  + LT + SL + 'tool_?call' + GT,
  'gi',
);

const argsRe = new RegExp(
  LT + '(?:arguments|parameters|input)' + GT + '([\\s\\S]*?)' + LT + SL + '(?:arguments|parameters|input)' + GT,
  'i',
);

const toolResultOpenRe = new RegExp('^' + LT + 'tool_result' + GT + '\\s*', 'i');
const toolResultCloseRe = new RegExp('\\s*' + LT + SL + 'tool_result' + GT + '$', 'i');

// ---- MiMo native tool_call blocks ----

function parseMimoNativeToolCalls(text: string): HarvestedToolCall[] {
  const calls: HarvestedToolCall[] = [];
  const clean = cleanInvisibleChars(text);

  let block: RegExpExecArray | null;

  while ((block = toolCallBlockRe.exec(clean)) !== null) {
    if (calls.length >= MAX_TOOL_CALLS) break;

    const toolCallName = block[1];
    let inner = block[2].trim();

    // Remove possible tool_result wrapper
    inner = inner.replace(toolResultOpenRe, '').replace(toolResultCloseRe, '');

    const callId = generateCallId();

    // Try JSON first
    if (inner.startsWith('{')) {
      const parsed = parseJsonSafely(inner);
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (obj.name) {
          const args = (obj.arguments ?? obj.parameters ?? obj.input ?? {}) as Record<string, unknown>;
          calls.push({
            name: String(obj.name),
            input: typeof args === 'object' && args !== null ? args : {},
            callId,
          });
          continue;
        }
      }
    }

    // Special format: first line is tool name, rest is JSON
    const lines = inner.split('\n');
    if (lines.length >= 2 && lines[1].trim().startsWith('{')) {
      const possibleName = lines[0].trim();
      const jsonPart = lines.slice(1).join('\n').trim();
      const parsed = parseJsonSafely(jsonPart);
      if (parsed && typeof parsed === 'object') {
        calls.push({
          name: toolCallName || possibleName,
          input: parsed as Record<string, unknown>,
          callId,
        });
        continue;
      }
    }

    // XML format
    const name = toolCallName || extractName(inner);
    if (name) {
      let argsXml = inner;
      const argsMatch = inner.match(argsRe);
      if (argsMatch) {
        argsXml = argsMatch[1];
      }
      calls.push({ name, input: parseXmlParams(argsXml), callId });
    }
  }

  return calls;
}

// ---- Named JSON: {"name":"Tool","arguments":{...}} ----

function parseNamedJsonToolCalls(text: string): HarvestedToolCall[] {
  const calls: HarvestedToolCall[] = [];
  const clean = cleanInvisibleChars(text);

  const namedJsonRe = /\{\s*"name"\s*:/g;
  let match: RegExpExecArray | null;

  while ((match = namedJsonRe.exec(clean)) !== null) {
    if (calls.length >= MAX_TOOL_CALLS) break;
    const start = match.index;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;

    for (let i = start; i < clean.length; i++) {
      const ch = clean[i];
      if (esc) { esc = false; continue; }
      if (ch === BS && inStr) { esc = true; continue; }
      if (ch === DQ) { inStr = !inStr; continue; }
      if (!inStr) {
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
    }
    if (end === -1) continue;

    const candidate = clean.slice(start, end);
    try {
      const parsed = parseJsonSafely(candidate);
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (obj.name && typeof obj.name === 'string'
            && (obj.arguments !== undefined || obj.parameters !== undefined || obj.input !== undefined)) {
          const args = (obj.arguments ?? obj.parameters ?? obj.input ?? {}) as Record<string, unknown>;
          calls.push({
            name: String(obj.name),
            input: typeof args === 'object' && args !== null ? args : {},
            callId: typeof obj.id === 'string' ? obj.id : generateCallId(),
          });
          namedJsonRe.lastIndex = end;
        }
      }
    } catch { /* skip invalid JSON */ }
  }
  return calls;
}

// ---- Public API ----

export function hasToolCallMarker(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const clean = cleanInvisibleChars(text);
  if (clean.includes(LT + 'tool_call') || clean.includes(LT + 'toolcall')
      || clean.includes(LT + 'function_calls' + GT)) {
    return true;
  }
  // Named JSON pattern
  if (clean.includes(DQ + 'name' + DQ) && clean.includes(DQ + 'arguments' + DQ)) {
    if (/\{\s*"name"\s*:\s*"[A-Z]/.test(clean)) return true;
  }
  return false;
}

export function parseToolCalls(text: string): HarvestedToolCall[] {
  if (!text || typeof text !== 'string') return [];
  const clean = cleanInvisibleChars(text);

  // Priority 1: tool_call XML blocks
  if (clean.includes(LT + 'tool_call') || clean.includes(LT + 'toolcall')) {
    const calls = parseMimoNativeToolCalls(clean);
    if (calls.length > 0) return calls;
  }

  // Priority 2: named JSON
  if (clean.includes(DQ + 'name' + DQ) && clean.includes(DQ + 'arguments' + DQ)) {
    const calls = parseNamedJsonToolCalls(clean);
    if (calls.length > 0) return calls;
  }

  // Priority 3: function_calls XML (Anthropic format)
  if (clean.includes(LT + 'function_calls' + GT)) {
    const calls: HarvestedToolCall[] = [];
    const fnCallsRe = new RegExp(
      LT + 'function_calls' + GT + '([\\s\\S]*?)' + LT + SL + 'function_calls' + GT,
      'gi',
    );
    const invokeRe = new RegExp(
      LT + 'invoke\\s+name=' + DQ + '([^' + DQ + ']+)' + DQ + GT + '([\\s\\S]*?)' + LT + SL + 'invoke' + GT,
      'gi',
    );
    let block: RegExpExecArray | null;
    while ((block = fnCallsRe.exec(clean)) !== null) {
      let inv: RegExpExecArray | null;
      while ((inv = invokeRe.exec(block[1])) !== null) {
        if (calls.length >= MAX_TOOL_CALLS) break;
        calls.push({
          name: inv[1].trim(),
          input: parseXmlParams(inv[2]),
          callId: generateCallId(),
        });
      }
    }
    if (calls.length > 0) return calls;
  }

  return [];
}
