import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const exec = promisify(execCb);

export interface ToolCallSpec {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResult {
  id: string;
  name: string;
  output: string;
  error?: string;
}

/**
 * Tool executor (trusts client-defined commands).
 * - Executes { name: 'shell', args: { command: string } } without internal
 *   whitelists or path restrictions.
 * - SECURITY: This mode trusts the caller. To re-enable safeguards in certain
 *   environments, set ROUTECODEX_TOOL_SAFE_MODE=1 (not default).
 */
export async function executeTool(spec: ToolCallSpec): Promise<ToolResult> {
  const name = String(spec.name || '').toLowerCase();
  if (name !== 'shell') {
    return { id: spec.id, name, output: '', error: `unsupported tool: ${name}` };
  }

  let command = '';
  try {
    const args = typeof spec.args === 'string' ? JSON.parse(spec.args) : (spec.args as Record<string, unknown>);
    const rawCmd = (args as any)?.command;

    const isArray = (v: any): v is any[] => Array.isArray(v);
    const isString = (v: any): v is string => typeof v === 'string';
    const looksJsonArray = (s: string) => {
      const t = s.trim();
      return t.startsWith('[') && t.endsWith(']');
    };
    const tryParseJsonArray = (s: string): any[] | null => {
      try { const v = JSON.parse(s); return Array.isArray(v) ? v : null; } catch { return null; }
    };
    const hasMeta = (tokensOrScript: string[] | string): boolean => {
      const metas = ['>>','<<','|',';','&&','||','>','<'];
      const test = (s: string) => metas.some(m => s.includes(m));
      if (typeof tokensOrScript === 'string') return test(tokensOrScript);
      return tokensOrScript.some(t => test(String(t)));
    };
    const quoteToken = (s: string) => {
      if (s === '') return "''";
      if (/[^A-Za-z0-9_\.\-\/:]/.test(s)) return "'" + s.replace(/'/g, "'\\''") + "'";
      return s;
    };
    const quoteScript = (s: string) => "'" + String(s).replace(/'/g, "'\\''") + "'";

    const normalizeBashLc = (script: string | string[]): string => {
      const sc = Array.isArray(script) ? script.map(String).join(' ') : String(script);
      return ['bash','-lc', quoteScript(sc)].map(quoteToken).join(' ');
    };

    const normalizeFromArray = (arr: any[]): string => {
      const tokens = arr.map((x) => String(x));
      if (tokens.length >= 2 && tokens[0] === 'bash' && tokens[1] === '-lc') {
        if (tokens.length === 3) {
          const t2 = tokens[2];
          // If the script itself is a JSON-array string, unwrap
          if (looksJsonArray(t2)) {
            const inner = tryParseJsonArray(t2);
            if (inner && inner.length) {
              if (inner[0] === 'bash' && inner[1] === '-lc') {
                if (inner.length >= 3) return normalizeBashLc(inner.slice(2).map(String).join(' '));
                return normalizeBashLc('');
              }
              // Treat as argv → if contains meta, convert to -lc script
              return hasMeta(inner.map(String))
                ? normalizeBashLc(inner.map(String).join(' '))
                : inner.map((t: any) => quoteToken(String(t))).join(' ');
            }
          }
          // Good shape: bash -lc 'script'
          return ['bash','-lc', quoteScript(t2)].map(quoteToken).join(' ');
        }
        // Merge tail tokens into one script
        return normalizeBashLc(tokens.slice(2));
      }
      // Not bash -lc
      if (tokens.length === 1 && looksJsonArray(tokens[0])) {
        const inner = tryParseJsonArray(tokens[0]);
        if (inner) return normalizeFromArray(inner);
      }
      return hasMeta(tokens)
        ? normalizeBashLc(tokens)
        : tokens.map(quoteToken).join(' ');
    };

    if (isArray(rawCmd)) {
      command = normalizeFromArray(rawCmd);
  } else if (isString(rawCmd)) {
      const s = String(rawCmd).trim();
      if (!s) {
        command = '';
      } else if (looksJsonArray(s)) {
        const inner = tryParseJsonArray(s);
        command = inner ? normalizeFromArray(inner) : (hasMeta(s) ? normalizeBashLc(s) : s);
      } else {
        // Handle patterns like: ["find", ".", "-name", "README.md"] | grep "codex-"
        const firstMetaIndex = (() => {
          const metas = ['|', '&&', '||', ';', '<<', '>>', '>', '<'];
          let idx = -1;
          for (const m of metas) {
            const i = s.indexOf(m);
            if (i >= 0) idx = (idx === -1) ? i : Math.min(idx, i);
          }
          return idx;
        })();
        if (s.startsWith('[')) {
          const bound = firstMetaIndex >= 0 ? firstMetaIndex : s.length;
          const arrPart = s.slice(0, bound).trim();
          const rest = firstMetaIndex >= 0 ? s.slice(bound).trim() : '';
          let parsed: any[] | null = null;
          try { if (arrPart.endsWith(']')) { const v = JSON.parse(arrPart); if (Array.isArray(v)) parsed = v; } } catch { parsed = null; }
          if (parsed && parsed.length) {
            const script = parsed.map(String).join(' ') + (rest ? (' ' + rest) : '');
            command = normalizeBashLc(script);
          } else {
            command = hasMeta(s) ? normalizeBashLc(s) : s;
          }
        } else {
          command = hasMeta(s) ? normalizeBashLc(s) : s;
        }
      }
    } else {
      command = '';
    }

    // Optional debug
    try {
      const DBG = String(process.env.ROUTECODEX_TOOL_EXEC_DEBUG || process.env.RCC_TOOL_EXEC_DEBUG || '0') === '1';
      if (DBG) {
        // eslint-disable-next-line no-console
        console.log('[TOOL-EXEC][normalize]', { raw: rawCmd, final: command });
      }
    } catch { /* ignore */ }
  } catch {
    return { id: spec.id, name, output: '', error: 'invalid arguments' };
  }

  if (!command) {
    return { id: spec.id, name, output: '', error: 'empty command' };
  }

  // Optional safe mode (disabled by default). When enabled, block control operators.
  const SAFE_MODE = String(process.env.ROUTECODEX_TOOL_SAFE_MODE || '').trim() === '1';
  if (SAFE_MODE && /[;&|]{1,2}/.test(command)) {
    return { id: spec.id, name, output: '', error: 'blocked by safe mode: control operators not allowed' };
  }

  try {
    const unifiedTimeout = Number(process.env.ROUTECODEX_TIMEOUT_MS || process.env.RCC_TIMEOUT_MS || 300000);
    const { stdout, stderr } = await exec(command, { timeout: unifiedTimeout, maxBuffer: 1024 * 1024 });
    const out = stdout?.toString()?.trim() || '';
    const err = stderr?.toString()?.trim() || '';
    const merged = [out, err].filter(Boolean).join('\n');
    return { id: spec.id, name, output: merged };
  } catch (e: any) {
    const msg = e?.message || String(e);
    return { id: spec.id, name, output: '', error: msg };
  }
}
