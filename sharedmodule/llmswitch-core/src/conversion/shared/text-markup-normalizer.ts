// Normalize textual markup into OpenAI tool_calls shape.
// Gated by RCC_TEXT_MARKUP_COMPAT=1 to avoid overreach.

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

export function normalizeAssistantTextToToolCalls(message: Record<string, any>): Record<string, any> {
  if (!enabled()) return message;
  try {
    if (!message || typeof message !== 'object') return message;
    if (Array.isArray((message as any).tool_calls) && (message as any).tool_calls.length) return message;
    const content = (message as any).content;
    const text = typeof content === 'string' ? content : null;
    if (!text) return message;
    // Order: rcc.wrapper → apply_patch → execute blocks
    const calls = (
      extractRCCToolCallsFromText(text) ||
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
