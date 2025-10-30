// Shared JSON-ish parsing helpers

export function tryParseJson<T = unknown>(s: unknown): T | unknown {
  if (typeof s !== 'string') return s as T;
  try { return JSON.parse(s) as T; } catch { return s as T; }
}

// Lenient parsing for function.arguments often produced by models
export function parseLenient(value: unknown): unknown {
  if (value === undefined || value === null) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return { _raw: String(value) };
  const s0 = value.trim();
  if (!s0) return {};
  // 1) strict JSON
  try { return JSON.parse(s0); } catch { /* continue */ }
  // 2) fenced ```json ... ``` or ``` ... ```
  const fence = s0.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fence ? fence[1] : s0;
  // 3) object substring
  const objMatch = candidate.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch { /* ignore */ } }
  // 4) array substring
  const arrMatch = candidate.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch { /* ignore */ } }
  // 5) single quotes → double; unquoted keys → quoted
  let t = candidate.replace(/'([^']*)'/g, '"$1"');
  t = t.replace(/([{,\s])([A-Za-z_][A-Za-z0-9_-]*)\s*:/g, '$1"$2":');
  try { return JSON.parse(t); } catch { /* ignore */ }
  // 6) key=value fallback across lines/commas
  const obj: Record<string, any> = {};
  const parts = candidate.split(/[\n,]+/).map(p => p.trim()).filter(Boolean);
  for (const p of parts) {
    const m = p.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*(.+)$/);
    if (!m) continue; const k = m[1]; let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    try { const pv = JSON.parse(v); obj[k] = pv; continue; } catch { /* fallthrough */ }
    if (/^(true|false)$/i.test(v)) { obj[k] = /^true$/i.test(v); continue; }
    if (/^-?\d+(?:\.\d+)?$/.test(v)) { obj[k] = Number(v); continue; }
    obj[k] = v;
  }
  return obj;
}

