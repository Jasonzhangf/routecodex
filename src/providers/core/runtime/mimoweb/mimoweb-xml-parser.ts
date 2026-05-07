/**
 * MiMo Web Provider - XML/JSON parsing utilities
 *
 * Shared parsing helpers ported from mimo2api parser.ts.
 * Used by mimoweb-tool-harvest.ts for response-side tool-call extraction.
 */

// ---------- String cleaning ----------

export function cleanInvisibleChars(text: string): string {
  return text
    .replace(/[\u200B-\u200D\uFEFF\u2060\u180E]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u00AD\u034F\u061C]/g, '')
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
}

// ---------- JSON repair + safe parse ----------

export function repairJson(json: string): string {
  let r = json;
  r = r.replace(/,(\s*[}\]])/g, '$1');
  r = r.replace(/([{\[])\s*,/g, '$1');
  r = r.replace(/\/\*[\s\S]*?\*\//g, '');
  r = r.replace(/\/\/.*/g, '');
  return r;
}

export function preprocessJsonString(text: string): string {
  const result: string[] = [];
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\' && i + 1 < text.length) {
        const next = text[i + 1];
        if ('"\\/bfnrt'.includes(next)) {
          result.push(ch, next);
          i += 2;
        } else if (next === 'u') {
          result.push(ch, next);
          i += 2;
          for (let j = 0; j < 4 && i < text.length && /[0-9a-fA-F]/.test(text[i]); j++) {
            result.push(text[i]);
            i++;
          }
        } else {
          result.push(next);
          i += 2;
        }
      } else if (ch === '"') {
        inString = false;
        result.push(ch);
        i++;
      } else if (ch === '\n') {
        result.push('\\n');
        i++;
      } else if (ch === '\r') {
        result.push('\\r');
        i++;
      } else if (ch === '\t') {
        result.push('\\t');
        i++;
      } else {
        result.push(ch);
        i++;
      }
    } else {
      if (ch === '"') inString = true;
      result.push(ch);
      i++;
    }
  }
  return result.join('');
}

export function parseJsonSafely(text: string): unknown {
  try { return JSON.parse(text); } catch { /* */ }
  try { return JSON.parse(repairJson(text)); } catch { /* */ }
  try { return JSON.parse(preprocessJsonString(text)); } catch { /* */ }
  try { return JSON.parse(repairJson(preprocessJsonString(text))); } catch { /* */ }
  return null;
}

// ---------- XML parameter parsing ----------

function parseValue(val: string): unknown {
  if (!val) return '';
  const trimmed = val.trim();
  if (trimmed === 'True' || trimmed === 'true') return true;
  if (trimmed === 'False' || trimmed === 'false') return false;
  if (trimmed === 'None' || trimmed === 'null') return null;
  try {
    const parsed = parseJsonSafely(trimmed);
    if (typeof parsed === 'string' && (parsed.startsWith('{') || parsed.startsWith('['))) {
      try { return parseJsonSafely(parsed); } catch { return parsed; }
    }
    return parsed ?? trimmed;
  } catch {
    return trimmed;
  }
}

export function parseXmlParams(xml: string): Record<string, unknown> {
  const trimmed = xml.trim();

  // Try JSON first
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = parseJsonSafely(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* */ }
  }

  const result: Record<string, unknown> = {};


  // Standard: <parameter name="key">value</parameter>
  const LT = String.fromCharCode(60);
  const GT = String.fromCharCode(62);
  const SL = String.fromCharCode(47);
  const DQ = String.fromCharCode(34);

  const re1 = new RegExp(LT + '(?:parameter|arg)\\s+name=' + DQ + '([^' + DQ + ']+)' + DQ + GT + '([\\s\\S]*?)' + LT + SL + '(?:parameter|arg)' + GT, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re1.exec(trimmed)) !== null) {
    result[m[1].trim()] = parseValue(m[2].trim());
  }

  const re2 = new RegExp(LT + '(?:parameter|arg)=([^>' + GT + '\\s/' + SL + ']+)' + GT + '([\\s\\S]*?)' + LT + SL + '(?:parameter|arg)' + GT, 'gi');
  while ((m = re2.exec(trimmed)) !== null) {
    result[m[1].trim()] = parseValue(m[2].trim());
  }

  const re3 = new RegExp(LT + '([a-zA-Z_][\\w-]*?)' + GT + '([\\s\\S]*?)' + LT + SL + '\\1' + GT, 'g');
  const reserved = new Set(['parameter', 'arg', 'name', 'function', 'tool_call', 'tool_result', 'arguments', 'parameters', 'input']);
  while ((m = re3.exec(trimmed)) !== null) {
    const key = m[1].trim();
    if (!reserved.has(key.toLowerCase())) {
      result[key] = parseValue(m[2].trim());
    }
  }

  return result;
}

export function extractName(inner: string): string | null {
  const LT = String.fromCharCode(60);
  const GT = String.fromCharCode(62);
  const SL = String.fromCharCode(47);
  const DQ = String.fromCharCode(34);

  let m = inner.match(new RegExp(LT + '(?:name|function|tool_name)' + GT + '([\\s\\S]*?)' + LT + SL + '(?:name|function|tool_name)' + GT, 'i'));
  if (m) return m[1].trim();

  m = inner.match(new RegExp(LT + '(?:name|function|tool_name)=' + DQ + '?([^' + DQ + LT + GT + '\\s/' + SL + ']+)' + DQ + '?', 'i'));
  if (m) return m[1].trim();

  const nameMatch = inner.match(new RegExp(DQ + 'name' + DQ + '\\s*:\\s*' + DQ + '([^' + DQ + ']+)' + DQ));
  if (nameMatch) return nameMatch[1];

  return null;
}
