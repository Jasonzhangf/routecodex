// Normalize textual markup into OpenAI tool_calls shape.
// Gated by RCC_TEXT_MARKUP_COMPAT=1 to avoid overreach.
import { isImagePath } from './media.js';

export type ToolCallLite = { id?: string; name: string; args: string };

function enabled(): boolean {
  try { return String((process as any)?.env?.RCC_TEXT_MARKUP_COMPAT ?? '1').trim() !== '0'; } catch { return true; }
}

export function extractRCCToolCallsFromText(text: string): ToolCallLite[] | null {
  try {
    if (typeof text !== 'string' || !text) return null;
    const out: ToolCallLite[] = [];
    const marker = /rcc\.tool\.v1/gi;
    let m: RegExpExecArray | null;
    while ((m = marker.exec(text)) !== null) {
      let start = -1;
      for (let i = m.index; i >= 0; i--) {
        const ch = text[i];
        if (ch === '{') { start = i; break; }
        if (m.index - i > 4096) break;
      }
      if (start < 0) continue;
      let depth = 0, end = -1, inStr = false, quote: string | null = null, esc = false;
      for (let j = start; j < text.length; j++) {
        const ch = text[j];
        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === quote) { inStr = false; quote = null; continue; }
          continue;
        } else {
          if (ch === '"' || ch === '\'') { inStr = true; quote = ch; continue; }
          if (ch === '{') { depth++; }
          else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
        }
      }
      if (end < 0) continue;
      const jsonStr = text.slice(start, end + 1);
      let obj: any = null; try { obj = JSON.parse(jsonStr); } catch { obj = null; }
      if (!obj || typeof obj !== 'object') continue;
      if (String(obj.version || '').toLowerCase() !== 'rcc.tool.v1') continue;
      const tool = obj.tool || {};
      const name = typeof tool.name === 'string' && tool.name.trim() ? tool.name.trim() : undefined;
      if (!name) continue;
      const callId = typeof tool.call_id === 'string' && tool.call_id.trim() ? tool.call_id.trim() : undefined;
      const argsObj = (obj.arguments !== undefined ? obj.arguments : {});
      // Guard: view_image must have a valid image path
      try {
        if (String(name).toLowerCase() === 'view_image') {
          const p = (argsObj && typeof argsObj === 'object') ? (argsObj as any).path : undefined;
          if (!isImagePath(p)) { continue; }
        }
      } catch { /* keep best-effort */ }
      let argsStr = '{}';
      try { argsStr = JSON.stringify(argsObj ?? {}); } catch { argsStr = '{}'; }
      out.push({ id: callId, name, args: argsStr });
      marker.lastIndex = end + 1;
    }
    return out.length ? out : null;
  } catch { return null; }
}

export function extractApplyPatchCallsFromText(text: string): ToolCallLite[] | null {
  try {
    if (typeof text !== 'string' || !text) return null;
    const out: ToolCallLite[] = [];
    const candidates: string[] = [];
    const fenceRe = /```(?:patch)?\s*([\s\S]*?)\s*```/gi;
    let fm: RegExpExecArray | null;
    while ((fm = fenceRe.exec(text)) !== null) {
      const body = fm[1] || '';
      if (/\*\*\*\s+Begin Patch[\s\S]*?\*\*\*\s+End Patch/.test(body)) candidates.push(body);
    }
    if (/\*\*\*\s+Begin Patch[\s\S]*?\*\*\*\s+End Patch/.test(text)) candidates.push(text);
    const genId = () => `call_${Math.random().toString(36).slice(2, 10)}`;
    for (const src of candidates) {
      const pg = /\*\*\*\s+Begin Patch[\s\S]*?\*\*\*\s+End Patch/gm;
      let pm: RegExpExecArray | null;
      while ((pm = pg.exec(src)) !== null) {
        const patch = pm[0];
        if (!patch || patch.length < 32) continue;
        let argsStr = '{}';
        try { argsStr = JSON.stringify({ patch }); } catch { argsStr = '{"patch":""}'; }
        out.push({ id: genId(), name: 'apply_patch', args: argsStr });
      }
    }
    return out.length ? out : null;
  } catch { return null; }
}

export function extractExecuteBlocksFromText(text: string): ToolCallLite[] | null {
  try {
    if (typeof text !== 'string' || !text) return null;
    const re = /<function=execute>\s*<parameter=command>([\s\S]*?)<\/parameter>\s*<\/function>/gi;
    const out: ToolCallLite[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const commandRaw = (m[1] || '').trim();
      if (!commandRaw) continue;
      let args = '{}';
      try { args = JSON.stringify({ command: commandRaw }); } catch { args = '{"command":""}'; }
      out.push({ id: `call_${Math.random().toString(36).slice(2, 10)}`, name: 'shell', args });
    }
    return out.length ? out : null;
  } catch { return null; }
}

// Extract XML-like <tool_call> blocks used by some agents:
// Example:
//   <tool_call>
//     shell
//     <arg_key>command</arg_key>
//     <arg_value>["cat","codex-protocol/README.md"]</arg_value>
//   </tool_call>
export function extractXMLToolCallsFromText(text: string): ToolCallLite[] | null {
  try {
    if (typeof text !== 'string' || !text) return null;
    const out: ToolCallLite[] = [];
    const blockRe = /<tool_call[\s\S]*?>([\s\S]*?)<\/tool_call>/gi;
    let bm: RegExpExecArray | null;
    while ((bm = blockRe.exec(text)) !== null) {
      const inner = (bm[1] || '').trim();
      if (!inner) continue;
      // 1) try function/name tags
      let name = '';
      const fnTag = inner.match(/<\s*(?:function|name)\s*>\s*([a-zA-Z0-9_\-\.]+)\s*<\/(?:function|name)\s*>/i);
      if (fnTag && fnTag[1]) {
        name = String(fnTag[1]).trim();
      } else {
        // 2) else pick the first non-empty line without tags as the name
        const lines = inner.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        const candidate = lines.find(l => !l.startsWith('<') && /^[a-zA-Z0-9_\-\.]+$/.test(l));
        if (candidate) name = candidate;
      }
      if (!name) continue;

      // Collect arg_key/arg_value pairs
      const argRe = /<\s*arg_key\s*>\s*([^<]+?)\s*<\/(?:arg_key)\s*>\s*<\s*arg_value\s*>\s*([\s\S]*?)\s*<\/(?:arg_value)\s*>/gi;
      let am: RegExpExecArray | null;
      const argsObj: Record<string, unknown> = {};
      while ((am = argRe.exec(inner)) !== null) {
        const k = (am[1] || '').trim();
        let vRaw = (am[2] || '').trim();
        if (!k) continue;
        // If value looks like JSON array/object, parse; else keep as string
        let v: unknown = vRaw;
        if ((vRaw.startsWith('[') && vRaw.endsWith(']')) || (vRaw.startsWith('{') && vRaw.endsWith('}'))) {
          try { v = JSON.parse(vRaw); } catch { v = vRaw; }
        }
        (argsObj as any)[k] = v;
      }
      // If no args collected but inner contains JSON object, try as whole arguments
      const hasAnyArg = Object.keys(argsObj).length > 0;
      if (!hasAnyArg) {
        const jsonMatch = inner.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        if (jsonMatch) {
          try { const val = JSON.parse(jsonMatch[0]); (argsObj as any).arguments = val; } catch { /* ignore */ }
        }
      }
      // Guard: view_image must have a valid image path
      try {
        if (String(name).toLowerCase() === 'view_image') {
          const p = (argsObj && typeof argsObj === 'object') ? (argsObj as any).path : undefined;
          if (!isImagePath(p)) { continue; }
        }
      } catch { /* ignore guard errors */ }
      let argsStr = '{}';
      try { argsStr = JSON.stringify(argsObj); } catch { argsStr = '{}'; }
      out.push({ id: `call_${Math.random().toString(36).slice(2, 10)}`, name, args: argsStr });
    }
    return out.length ? out : null;
  } catch { return null; }
}

export function normalizeAssistantTextToToolCalls(message: Record<string, any>): Record<string, any> {
  if (!enabled()) return message;
  try {
    if (!message || typeof message !== 'object') return message;
    if (Array.isArray((message as any).tool_calls) && (message as any).tool_calls.length) return message;
    const content = (message as any).content;
    const text = typeof content === 'string' ? content : null;
    if (!text) return message;
    // Order: rcc.wrapper → xml-like tool_call → apply_patch → execute blocks
    const calls = (
      extractRCCToolCallsFromText(text) ||
      extractXMLToolCallsFromText(text) ||
      extractApplyPatchCallsFromText(text) ||
      extractExecuteBlocksFromText(text)
    );
    if (calls && calls.length) {
      const toolCalls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } }));
      const copy = { ...message };
      copy.tool_calls = toolCalls;
      copy.content = '';
      return copy;
    }
  } catch { /* ignore */ }
  return message;
}
