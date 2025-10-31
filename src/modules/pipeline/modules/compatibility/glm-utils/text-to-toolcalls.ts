/**
 * GLM-specific textual tool-call harvester
 *
 * Extracts tool-call intents embedded in reasoning_content text and returns
 * a list of normalized calls plus the remainder text (with extracted blocks removed).
 */

export type ToolCallLite = { id?: string; name: string; args: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isImagePath(p: unknown): boolean {
  try { const s = String(p || '').toLowerCase(); return /\.(png|jpe?g|gif|webp|bmp|svg|tiff?|ico|heic|jxl)$/.test(s); } catch { return false; }
}

function stringifyArgs(obj: unknown): string {
  if (typeof obj === 'string') return obj;
  try { return JSON.stringify(obj ?? {}); } catch { return '{}'; }
}

function genId(): string { return `call_${Math.random().toString(36).slice(2, 10)}`; }

function extractRCCToolCallsFromText(text: string): { calls: ToolCallLite[]; cuts: Array<[number, number]> } {
  const out: ToolCallLite[] = [];
  const cuts: Array<[number, number]> = [];
  try {
    const marker = /rcc\.tool\.v1/gi;
    let m: RegExpExecArray | null;
    while ((m = marker.exec(text)) !== null) {
      // backtrack to find matching JSON object start
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
        } else {
          if (ch === '"' || ch === '\'') { inStr = true; quote = ch; continue; }
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
        }
      }
      if (end < 0) continue;
      const jsonStr = text.slice(start, end + 1);
      let obj: any = null; try { obj = JSON.parse(jsonStr); } catch { obj = null; }
      if (!isObject(obj)) continue;
      if (String((obj as any).version || '').toLowerCase() !== 'rcc.tool.v1') continue;
      const tool = (obj as any).tool || {};
      const name = typeof tool.name === 'string' && tool.name.trim() ? tool.name.trim() : undefined;
      if (!name) continue;
      const argsObj = (obj as any).arguments !== undefined ? (obj as any).arguments : {};
      // view_image guard
      if (name.toLowerCase() === 'view_image') {
        const p = isObject(argsObj) ? (argsObj as any).path : undefined;
        if (!isImagePath(p)) { cuts.push([start, end + 1]); continue; }
      }
      out.push({ id: tool.call_id || genId(), name, args: stringifyArgs(argsObj) });
      cuts.push([start, end + 1]);
      marker.lastIndex = end + 1;
    }
  } catch { /* ignore */ }
  return { calls: out, cuts };
}

function extractApplyPatchCallsFromText(text: string): { calls: ToolCallLite[]; cuts: Array<[number, number]> } {
  const out: ToolCallLite[] = [];
  const cuts: Array<[number, number]> = [];
  try {
    const candidates: Array<[number, number]> = [];
    // fenced blocks
    const fenceRe = /```(?:patch)?\s*([\s\S]*?)\s*```/gi; let fm: RegExpExecArray | null;
    while ((fm = fenceRe.exec(text)) !== null) {
      const body = fm[1] || '';
      if (/\*\*\*\s+Begin Patch[\s\S]*?\*\*\*\s+End Patch/.test(body)) {
        // approximate cut inside fence (best-effort): skip fence itself
        const segment = fm[0];
        const idx = text.indexOf(segment, fm.index);
        if (idx >= 0) candidates.push([idx, idx + segment.length]);
      }
    }
    // inline blocks
    const pg = /\*\*\*\s+Begin Patch[\s\S]*?\*\*\*\s+End Patch/gm; let pm: RegExpExecArray | null;
    while ((pm = pg.exec(text)) !== null) {
      candidates.push([pm.index, pm.index + pm[0].length]);
    }
    for (const [s, e] of candidates) {
      const patch = text.slice(s, e);
      if (patch && patch.length >= 32) {
        out.push({ id: genId(), name: 'apply_patch', args: stringifyArgs({ patch }) });
        cuts.push([s, e]);
      }
    }
  } catch { /* ignore */ }
  return { calls: out, cuts };
}

function extractExecuteBlocksFromText(text: string): { calls: ToolCallLite[]; cuts: Array<[number, number]> } {
  const out: ToolCallLite[] = [];
  const cuts: Array<[number, number]> = [];
  try {
    const re = /<function=execute>\s*<parameter=command>([\s\S]*?)<\/parameter>\s*<\/function>/gi; let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const cmd = (m[1] || '').trim();
      if (!cmd) continue;
      out.push({ id: genId(), name: 'shell', args: stringifyArgs({ command: cmd }) });
      cuts.push([m.index, m.index + m[0].length]);
    }
  } catch { /* ignore */ }
  return { calls: out, cuts };
}

function extractXMLToolCallsFromText(text: string): { calls: ToolCallLite[]; cuts: Array<[number, number]> } {
  const out: ToolCallLite[] = [];
  const cuts: Array<[number, number]> = [];
  try {
    const blockRe = /<tool_call[\s\S]*?>([\s\S]*?)<\/tool_call>/gi; let bm: RegExpExecArray | null;
    while ((bm = blockRe.exec(text)) !== null) {
      const whole = bm[0];
      const inner = (bm[1] || '').trim(); if (!inner) { cuts.push([bm.index, bm.index + whole.length]); continue; }
      // name: function/name tags, or first token after <tool_call>
      let name = '';
      const tag = inner.match(/<\s*(?:function|name)\s*>\s*([a-zA-Z0-9_\-\.]+)\s*<\/(?:function|name)\s*>/i);
      if (tag && tag[1]) name = tag[1].trim();
      if (!name) {
        // Pattern: inner may start with nested <tool_call>shell without separate <name> tag
        const nm2 = inner.match(/<\s*tool_call\s*>\s*([a-zA-Z0-9_\-\.]+)/i);
        if (nm2 && nm2[1]) name = nm2[1].trim();
      }
      if (!name) {
        // Fallback: take first bare token at start
        const nm = inner.match(/^(?:\s*?)([a-zA-Z0-9_\-\.]+)\s*(?:\r?\n|<)/);
        if (nm && nm[1]) name = nm[1].trim();
      }
      if (!name) { cuts.push([bm.index, bm.index + whole.length]); continue; }
      // args via <arg_key>/<arg_value>
      const argsObj: Record<string, unknown> = {};
      const argRe = /<\s*arg_key\s*>\s*([^<]+?)\s*<\/arg_key>\s*<\s*arg_value\s*>\s*([\s\S]*?)\s*<\/arg_value>/gi; let am: RegExpExecArray | null;
      while ((am = argRe.exec(inner)) !== null) {
        const k = (am[1] || '').trim(); let vRaw = (am[2] || '').trim(); if (!k) continue;
        let v: unknown = vRaw;
        if ((vRaw.startsWith('[') && vRaw.endsWith(']')) || (vRaw.startsWith('{') && vRaw.endsWith('}'))) {
          try { v = JSON.parse(vRaw); } catch { v = vRaw; }
        }
        argsObj[k] = v;
      }
      // view_image guard
      if (name.toLowerCase() === 'view_image') {
        const p = (argsObj as any).path;
        if (!isImagePath(p)) { cuts.push([bm.index, bm.index + whole.length]); continue; }
      }
      out.push({ id: genId(), name, args: stringifyArgs(argsObj) });
      cuts.push([bm.index, bm.index + whole.length]);
    }
  } catch { /* ignore */ }
  return { calls: out, cuts };
}

export function harvestToolCallsFromText(input: string): { toolCalls: ToolCallLite[]; remainder: string } {
  if (typeof input !== 'string' || !input.trim()) {
    return { toolCalls: [], remainder: typeof input === 'string' ? input : '' };
  }
  const text = String(input);
  const segments: Array<[number, number]> = [];
  const calls: ToolCallLite[] = [];

  const merge = (res: { calls: ToolCallLite[]; cuts: Array<[number, number]> }) => {
    if (res.calls && res.calls.length) calls.push(...res.calls);
    if (res.cuts && res.cuts.length) segments.push(...res.cuts);
  };

  merge(extractRCCToolCallsFromText(text));
  merge(extractXMLToolCallsFromText(text));
  merge(extractApplyPatchCallsFromText(text));
  merge(extractExecuteBlocksFromText(text));

  // Sort and coalesce cuts
  segments.sort((a,b)=> a[0]-b[0] || a[1]-b[1]);
  const coalesced: Array<[number, number]> = [];
  for (const [s,e] of segments) {
    if (!coalesced.length || s > coalesced[coalesced.length-1][1]) coalesced.push([s,e]);
    else coalesced[coalesced.length-1][1] = Math.max(coalesced[coalesced.length-1][1], e);
  }
  // Build remainder by cutting out extracted segments
  let remainder = '';
  let prev = 0;
  for (const [s,e] of coalesced) { remainder += text.slice(prev, s); prev = e; }
  remainder += text.slice(prev);

  // Adjacent duplicate dedupe (same name+args)
  const filtered: ToolCallLite[] = [];
  for (const c of calls) {
    const prevC = filtered.length ? filtered[filtered.length-1] : null;
    if (prevC && prevC.name === c.name && prevC.args === c.args) continue;
    filtered.push(c);
  }

  return { toolCalls: filtered, remainder };
}

// 将工具调用转换为标准的 rcc.tool.v1 JSON 字符串（仅意图，不包含 executed/result）
export function toolCallsToRccJsonBlocks(calls: ToolCallLite[]): string[] {
  const blocks: string[] = [];
  for (const c of calls || []) {
    try {
      let argsObj: any = {};
      if (typeof c.args === 'string') {
        try { argsObj = JSON.parse(c.args); } catch { argsObj = { _raw: c.args }; }
      } else if (c.args && typeof (c.args as any) === 'object') {
        argsObj = c.args;
      }
      const env = {
        version: 'rcc.tool.v1',
        tool: { name: c.name, ...(c.id ? { call_id: c.id } : {}) },
        arguments: argsObj
      } as Record<string, unknown>;
      blocks.push(JSON.stringify(env));
    } catch { /* ignore one block */ }
  }
  return blocks;
}

// 从文本中抽取工具意图，并且以 rcc.tool.v1 JSON 块形式返回，同时给出剩余文本
export function harvestRccBlocksFromText(input: string): { blocks: string[]; remainder: string } {
  if (typeof input !== 'string' || !input.trim()) {
    return { blocks: [], remainder: typeof input === 'string' ? input : '' };
  }
  const { toolCalls, remainder } = harvestToolCallsFromText(input);
  const blocks = toolCallsToRccJsonBlocks(toolCalls);
  return { blocks, remainder };
}
