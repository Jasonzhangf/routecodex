import { augmentOpenAITools, refineSystemToolGuidance } from '../../guidance/index.js';
import { isImagePath } from './media.js';
import { normalizeAssistantTextToToolCalls } from './text-markup-normalizer.js';

type Unknown = Record<string, unknown>;

function isObject(v: unknown): v is Unknown {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export interface OpenAIChatPayload {
  model?: string;
  messages?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
  [k: string]: unknown;
}

export function applyOpenAIToolingStage(payload: OpenAIChatPayload): OpenAIChatPayload {
  if (!payload || typeof payload !== 'object') return payload;
  const out: OpenAIChatPayload = { ...(payload as any) };

  // 0) Promote embedded <system-reminder> from user content to a real system message (no generic fallback)
  try {
    const on = String((process as any)?.env?.RCC_SYSTEM_TOOL_GUIDANCE ?? '1').trim() !== '0';
    if (on && Array.isArray(out.messages) && out.messages.length) {
      const first = out.messages[0];
      const role = String((first as any)?.role || '').toLowerCase();
      const content = (first as any)?.content;
      if (role !== 'system' && typeof content === 'string' && content) {
        const re = /<\s*system-reminder\s*>([\s\S]*?)<\s*\/\s*system-reminder\s*>/i;
        const m = content.match(re);
        if (m && m[1] && m[1].trim()) {
          const sysText = m[1].trim();
          const rest = content.replace(re, '').trim();
          const promoted = [{ role: 'system', content: sysText } as Record<string, unknown>, { ...(first as any), content: rest } as Record<string, unknown>, ...out.messages.slice(1)];
          out.messages = promoted;
        }
      }
    }
  } catch { /* ignore */ }

  // 1) Refine system guidance when enabled
  try {
    const on = String((process as any)?.env?.RCC_SYSTEM_TOOL_GUIDANCE ?? '1').trim() !== '0';
    if (on && Array.isArray(out.messages) && out.messages.length) {
      const first = out.messages[0];
      if (first && (first as any).role === 'system' && typeof (first as any).content === 'string') {
        const refined = refineSystemToolGuidance(String((first as any).content));
        if (refined !== (first as any).content) {
          out.messages = [{ ...(first as any), content: refined }, ...out.messages.slice(1)];
        }
      }
    }
  } catch { /* ignore */ }

  // 2) Augment tool definitions into strict, guided OpenAI function tools
  try {
    if (Array.isArray(out.tools) && out.tools.length) {
      out.tools = augmentOpenAITools(out.tools) as any[];
    }
  } catch { /* ignore */ }

  // 3) Normalize textual assistant content to tool_calls (gated)
  try {
    if (Array.isArray(out.messages) && out.messages.length) {
      const last = out.messages[out.messages.length - 1];
      if (isObject(last) && String((last as any).role || '').toLowerCase() === 'assistant') {
        const normalized = normalizeAssistantTextToToolCalls(last as any);
        const msg = (normalized !== last) ? normalized : last;
        // Adjacent duplicate tool_call dedupe (same function.name + arguments)
        try {
          const calls = Array.isArray((msg as any).tool_calls) ? ((msg as any).tool_calls as any[]) : [];
          if (calls.length > 1) {
            const filtered: any[] = [];
            const sameKey = (a: any, b: any) => {
              const an = String(a?.function?.name || '').trim();
              const bn = String(b?.function?.name || '').trim();
              const aa = typeof a?.function?.arguments === 'string' ? a.function.arguments : JSON.stringify(a?.function?.arguments ?? '');
              const ba = typeof b?.function?.arguments === 'string' ? b.function.arguments : JSON.stringify(b?.function?.arguments ?? '');
              return an === bn && aa === ba;
            };
            for (const c of calls) {
              const prev = filtered.length ? filtered[filtered.length - 1] : null;
              if (prev && sameKey(prev, c)) { continue; }
              filtered.push(c);
            }
            (msg as any).tool_calls = filtered;
          }
        } catch { /* ignore dedupe errors */ }

        // Rewrite invalid view_image to shell cat (enforce tool guidance at source)
        try {
          const tcs = Array.isArray((msg as any).tool_calls) ? ((msg as any).tool_calls as any[]) : [];
          if (tcs.length > 0) {
            const rewrited = tcs.map((tc: any) => {
              try {
                const fn = tc?.function || {};
                const name = String(fn?.name || '').trim();
                // Parse arguments to object (accept string or object)
                const argStr = typeof fn?.arguments === 'string' ? fn.arguments : (fn?.arguments != null ? JSON.stringify(fn.arguments) : '{}');
                let argsObj: any = {}; try { argsObj = JSON.parse(argStr); } catch { argsObj = {}; }
                if (name === 'view_image') {
                  const p = (argsObj && typeof argsObj === 'object') ? (argsObj as any).path : undefined;
                  if (!isImagePath(p)) {
                    const pathVal = typeof p === 'string' ? p : String(p ?? '');
                    const script = pathVal ? `cat ${pathVal.replace(/"/g, '\\"')}` : 'true';
                    const shArgs = { command: ['bash','-lc', script] } as any;
                    let shArgStr = '{}'; try { shArgStr = JSON.stringify(shArgs); } catch { shArgStr = '{"command":["bash","-lc","true"]}'; }
                    const id = typeof tc?.id === 'string' ? tc.id : `call_${Math.random().toString(36).slice(2,8)}`;
                    return { id, type: 'function', function: { name: 'shell', arguments: shArgStr } };
                  }
                }
              } catch { /* keep tc as-is */ }
              return tc;
            });
            (msg as any).tool_calls = rewrited;
            // Additional shell fixups (e.g., common find misuse):
        try {
          const tcs2 = Array.isArray((msg as any).tool_calls) ? ((msg as any).tool_calls as any[]) : [];
          const fixed = tcs2.map((tc: any) => {
            try {
              const fn = tc?.function || {};
              const nm = String(fn?.name || '').trim().toLowerCase();
              const argStr = typeof fn?.arguments === 'string' ? fn.arguments : (fn?.arguments != null ? JSON.stringify(fn.arguments) : '{}');
              let aobj: any = {}; try { aobj = JSON.parse(argStr); } catch { aobj = {}; }
              if (nm === 'shell' && Array.isArray(aobj?.command) && aobj.command.length > 0 && String(aobj.command[0]).toLowerCase() === 'find') {
                    const toks = aobj.command.map((x: any) => String(x));
                    const patched: string[] = [];
                    patched.push('find');
                    let idx = 1;
                    if (toks.length > 1) {
                      const t1 = toks[1];
                      if (t1 === '.') { patched.push('.'); idx = 2; } else { patched.push('.'); }
                    } else { patched.push('.'); }
                    const names: string[] = [];
                    const keep: string[] = [];
                    let typeVal: string | null = null;
                    for (let i = idx; i < toks.length; i++) {
                      const t = toks[i];
                      if (t === '-type' && i + 1 < toks.length) { typeVal = toks[i + 1]; i++; continue; }
                      if (t === '-name' && i + 1 < toks.length) { names.push(toks[i + 1]); i++; continue; }
                      if (t === '-o') continue;
                      keep.push(t);
                    }
                    const looksExt = (s: string) => /^\.[A-Za-z0-9]+$/.test(s) || /^\*\.[A-Za-z0-9]+$/.test(s);
                    if (!typeVal && names.some(looksExt)) typeVal = 'f';
                    if (typeVal) { patched.push('-type'); patched.push(typeVal); }
                    const keepJoined = keep.join(' ');
                    if (!/node_modules/.test(keepJoined)) { patched.push('-not','-path','./node_modules/*'); }
                    if (!/\.git/.test(keepJoined)) { patched.push('-not','-path','./.git/*'); }
                    if (names.length > 0) {
                      patched.push('(');
                      names.forEach((n, i) => {
                        let pat = String(n);
                        if (looksExt(pat) && !pat.startsWith('*')) pat = `*${pat}`;
                        patched.push('-name'); patched.push(pat);
                        if (i !== names.length - 1) patched.push('-o');
                      });
                      patched.push(')');
                    }
                    patched.push(...keep);
                    (aobj as any).command = patched;
                    try { fn.arguments = JSON.stringify(aobj); } catch { /* ignore */ }
                    return { ...tc, function: fn };
                  }
                } catch { /* ignore */ }
                return tc;
              });
              (msg as any).tool_calls = fixed;
            } catch { /* ignore */ }
          }
        } catch { /* ignore rewrite errors */ }
        out.messages = [...out.messages.slice(0, -1), msg];
      }
    }
  } catch { /* ignore */ }

  // (no per-command shell fixups here; avoid command-specific policy at this layer)

  return out;
}
