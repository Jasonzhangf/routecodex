/**
 * Shared utility: extract human-readable text from a tool result payload.
 *
 * Preference order:
 * - output -> text -> content (string)
 * - if content is an array, recursively flatten items' text/content
 * - if the value is a JSON-stringified object/array, parse then retry
 * - otherwise synthesize a deterministic summary from metadata (exit_code/duration)
 */

export function extractToolText(value: unknown): string {
  const env = typeof process !== 'undefined' ? process.env || {} : ({} as Record<string,string>);
  // Default to minimal success-first behavior; enable JSON dump only via env=1
  const FAITHFUL = (env.ROUTECODEX_TOOL_TEXT_FAITHFUL === '1') || (env.RCC_TOOL_TEXT_FAITHFUL === '1');
  const MAX_LINES = Number(env.ROUTECODEX_TOOL_TEXT_MAX_LINES || env.RCC_TOOL_TEXT_MAX_LINES || 200);
  const MAX_CHARS = Number(env.ROUTECODEX_TOOL_TEXT_MAX_CHARS || env.RCC_TOOL_TEXT_MAX_CHARS || 20000);
  // Helpers
  const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');
  const push = (arr: string[], s?: string) => {
    if (typeof s === 'string') {
      const t = stripAnsi(s).trim();
      if (t) arr.push(t);
    }
  };
  const uniqMerge = (parts: string[], limitLines = MAX_LINES, limitChars = MAX_CHARS) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of parts) {
      if (!p) continue;
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
      if (out.length >= limitLines) break;
      const total = out.join('\n');
      if (total.length >= limitChars) break;
    }
    let text = out.join('\n');
    if (text.length > limitChars) {
      text = `[输出已截断至 ${limitChars} 字符]\n` + text.slice(0, limitChars - 12) + '\n...(truncated)';
    }
    return text;
  };
  const flattenParts = (v: unknown): string[] => {
    const texts: string[] = [];
    if (Array.isArray(v)) {
      for (const p of v) {
        if (!p) continue;
        if (typeof p === 'string') { push(texts, p); continue; }
        if (p && typeof p === 'object') {
          const obj: any = p as any;
          if (typeof obj.text === 'string') { push(texts, obj.text); continue; }
          if (typeof obj.content === 'string') { push(texts, obj.content); continue; }
          if (Array.isArray(obj.content)) { texts.push(...flattenParts(obj.content)); continue; }
        }
      }
    }
    return texts;
  };

  // String case: attempt to parse JSON-looking strings; otherwise return as-is
  if (typeof value === 'string') {
    const s = value.trim();
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try {
        const parsed = JSON.parse(s);
        const t = extractToolText(parsed);
        if (t) return t;
      } catch { /* ignore parse errors */ }
    }
    return stripAnsi(s);
  }

  // Object/Array cases
  if (Array.isArray(value)) {
    // Prefer pure textual parts
    const t = flattenParts(value).join('\n').trim();
    if (t) return t;
    // Fallback to JSON when explicitly requested
    if (FAITHFUL) {
      try {
        const txt = JSON.stringify(value);
        if (txt.length > MAX_CHARS) {
          return `[输出已截断至 ${MAX_CHARS} 字符]\n` + txt.slice(0, MAX_CHARS - 12) + '\n...(truncated)';
        }
        return txt;
      } catch { /* ignore */ }
    }
    return '';
  }

  if (value && typeof value === 'object') {
    const obj: any = value as any;

    // Collect candidates by priority buckets
    const errors: string[] = [];
    const outputs: string[] = [];
    const summaries: string[] = [];
    let exitCode: number | undefined = undefined;
    let duration: number | undefined = undefined;
    let executedLine: string | undefined = undefined;
    let executedTokens: string[] | null = null;
    let toolName: string | undefined = undefined;

    // Exit/metadata
    try {
      const meta: any = obj.metadata || obj.meta || {};
      if (typeof meta.exit_code === 'number') exitCode = meta.exit_code;
      if (typeof meta.duration_seconds === 'number') duration = meta.duration_seconds;
      if (typeof obj.exit_code === 'number' && exitCode === undefined) exitCode = obj.exit_code;
      if (typeof obj.duration_seconds === 'number' && duration === undefined) duration = obj.duration_seconds;
    } catch { /* ignore */ }

    // Executed/command echo
    try {
      // Prefer nested executed.command (our rcc.tool.v1 envelope), then fallbacks
      const exec = obj.executed;
      if (exec && typeof exec === 'object' && Array.isArray(exec.command)) {
        executedTokens = (exec.command as any[]).map((x) => String(x));
        executedLine = `Executed: ${executedTokens.join(' ')}`;
      } else {
        const cmdRaw = obj.command ?? obj.argv ?? obj.cmd;
        if (Array.isArray(cmdRaw)) {
          executedTokens = (cmdRaw as any[]).map((x) => String(x));
          executedLine = `Executed: ${executedTokens.join(' ')}`;
        } else if (typeof cmdRaw === 'string') {
          executedLine = `Executed: ${cmdRaw}`;
        }
      }
      if (!toolName && obj.tool && typeof obj.tool === 'object') {
        const tn = (obj.tool as any).name;
        if (typeof tn === 'string' && tn.trim()) toolName = tn.trim();
      }
    } catch { /* ignore */ }

    // Error-priority fields
    const pickFirstLine = (s: string) => {
      const t = stripAnsi(s).trim();
      const idx = t.indexOf('\n');
      return idx >= 0 ? t.slice(0, idx).trim() : t;
    };

    const errFields: Array<[string, unknown]> = [
      ['stderr', obj.stderr],
      ['error', obj.error],
      ['reason', obj.reason],
      ['message', obj.message],
      ['failure', obj.failure],
      ['fail_msg', obj.fail_msg],
      ['exception', obj.exception],
      ['cause', obj.cause],
      ['stack', obj.stack]
    ];
    for (const [, v] of errFields) {
      if (!v) continue;
      if (typeof v === 'string') { push(errors, pickFirstLine(v)); continue; }
      if (Array.isArray(v)) { push(errors, pickFirstLine(flattenParts(v).join('\n'))); continue; }
      if (typeof v === 'object') {
        const vv: any = v as any;
        if (typeof vv.message === 'string') { push(errors, pickFirstLine(vv.message)); continue; }
        push(errors, pickFirstLine(JSON.stringify(vv)));
      }
    }

    // Primary outputs
    const outFields: Array<[string, unknown]> = [
      ['output', obj.output],
      ['stdout', obj.stdout],
      ['text', obj.text],
      ['content', obj.content],
      ['result', obj.result]
    ];
    for (const [k, v] of outFields) {
      if (!v) continue;
      if (typeof v === 'string') { push(outputs, v); continue; }
      if (Array.isArray(v)) { outputs.push(...flattenParts(v)); continue; }
      if (typeof v === 'object') {
        const vv: any = v as any;
        if (typeof vv.text === 'string') { push(outputs, vv.text); continue; }
        if (typeof vv.content === 'string') { push(outputs, vv.content); continue; }
        if (Array.isArray(vv.content)) { outputs.push(...flattenParts(vv.content)); continue; }
      }
      // Fallback stringify for unusual structures under these keys
      if (k === 'result') { try { push(outputs, JSON.stringify(v)); } catch { /* ignore */ } }
    }

    // Success-first: if stdout/output present, return only that (no merges)
    const outMerged = uniqMerge(outputs).trim();
    if (outMerged) return outMerged;

    // Otherwise, return stderr/error text to avoid silent failures
    const errMerged = uniqMerge(errors).trim();
    if (errMerged) return errMerged;

    // If the command succeeded with no output, emit a clear success marker (with write summary when possible)
    if (exitCode === 0) {
      const summarize = (): string | null => {
        // Detect heredoc/redirect writes inside bash -lc scripts
        const script = (() => {
          if (executedTokens && executedTokens.length >= 3 && executedTokens[0] === 'bash' && executedTokens[1] === '-lc') {
            return String(executedTokens[2] || '');
          }
          return '';
        })();
        const detectWriteTarget = (s: string): string | null => {
          try {
            // cat > path << 'EOF' ...
            const m1 = s.match(/cat\s*>\s*([^\s]+)\s*<<\s*['\"]?EOF['\"]?/i);
            if (m1 && m1[1]) return m1[1];
            // generic redirect: > path or >> path
            const m2 = s.match(/[>]{1,2}\s*([^\s;&|]+)/);
            if (m2 && m2[1]) return m2[1];
          } catch { /* ignore */ }
          return null;
        };
        const detectSedEdit = (s: string): string | null => {
          try {
            // naive: last non-flag token as path when sed -i present
            if (!/\bsed\b[^\n]*\-i\b/i.test(s)) return null;
            const parts = s.split(/\s+/).filter(Boolean);
            let path: string | null = null;
            for (let i = parts.length - 1; i >= 0; i--) {
              const t = parts[i];
              if (/^-/.test(t)) continue;
              path = t; break;
            }
            return path;
          } catch { return null; }
        };
        const writePath = script ? detectWriteTarget(script) : null;
        const sedPath = script ? detectSedEdit(script) : null;

        if ((toolName && toolName === 'apply_patch')) {
          return '补丁应用成功\n建议继续使用 apply_patch 进行文件编辑。';
        }
        if (writePath) {
          return `写入成功: ${writePath}\n建议改用 apply_patch 工具进行文件编辑，避免 heredoc/重定向。`;
        }
        if (sedPath) {
          return `修改成功: ${sedPath}\n建议改用 apply_patch 工具进行文件编辑，避免就地编辑。`;
        }
        return 'Command succeeded (no output).\n建议改用 apply_patch 工具进行文件编辑。';
      };
      const msg = summarize();
      if (executedLine) return msg ? `${msg}\n${executedLine}` : executedLine;
      return msg || 'Command succeeded (no output).';
    }

    // Fallbacks: minimal metadata or faithful JSON when requested
    if (FAITHFUL) {
      try {
        const txt = JSON.stringify(value);
        return txt.length > MAX_CHARS ? (txt.slice(0, MAX_CHARS - 12) + '\n...(truncated)') : txt;
      } catch { /* ignore */ }
    }
    if (exitCode !== undefined) return `Exit code: ${exitCode}`;
    if (executedLine) return executedLine;
    return '';
  }

  return '';
}
