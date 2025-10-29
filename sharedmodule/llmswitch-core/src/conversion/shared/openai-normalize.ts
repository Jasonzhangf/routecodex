export function normalizeChatRequest(request: any): any {
  if (!request || typeof request !== 'object') return request;
  const normalized = { ...request };

  if (Array.isArray(normalized.messages)) {
    normalized.messages = normalized.messages.map((msg: any) => normalizeMessage(msg));
  }

  if (Array.isArray(normalized.tools)) {
    normalized.tools = normalized.tools.map((tool: any) => normalizeTool(tool));
  }

  // MCP injection (CCR style) moved into core so both Chat/Responses paths stay consistent.
  try {
    const enableMcp = String((process as any)?.env?.ROUTECODEX_MCP_ENABLE ?? '1') !== '0';
    if (enableMcp) {
      const known = new Set<string>();
      // Discover only from explicit arguments.server in history (do NOT infer from dotted prefix)
      try {
        const msgs = Array.isArray((normalized as any).messages) ? ((normalized as any).messages as any[]) : [];
        for (const m of msgs) {
          if (!m || typeof m !== 'object') continue;
          if ((m as any).role === 'tool' && typeof (m as any).content === 'string') {
            try { const obj = JSON.parse((m as any).content); const sv = obj?.arguments?.server; if (typeof sv === 'string' && sv.trim()) known.add(sv.trim()); } catch { /* ignore */ }
          }
          if ((m as any).role === 'assistant' && Array.isArray((m as any).tool_calls)) {
            for (const tc of ((m as any).tool_calls as any[])) {
              try { const argStr = String(tc?.function?.arguments ?? ''); const parsed = JSON.parse(argStr); const sv = parsed?.server; if (typeof sv === 'string' && sv.trim()) known.add(sv.trim()); } catch { /* ignore */ }
            }
          }
        }
      } catch { /* ignore */ }

      // Merge env-provided servers if any
      const serversRaw = String((process as any)?.env?.ROUTECODEX_MCP_SERVERS || '').trim();
      if (serversRaw) { for (const s of serversRaw.split(',').map((x: string) => x.trim()).filter(Boolean)) known.add(s); }

      const serverList = Array.from(known);
      const serverProp = serverList.length ? { type: 'string', enum: serverList } : { type: 'string' };
      const objSchema = (props: any, req: string[]) => ({ type: 'object', properties: props, required: req, additionalProperties: false });

      const ensureToolsArray = () => {
        if (!Array.isArray((normalized as any).tools)) (normalized as any).tools = [] as any[];
      };

      // Phase filter + injection: unknown -> only list, known -> list + read + templates
      ensureToolsArray();
      const currentTools: any[] = ((normalized as any).tools as any[]);
      const outTools: any[] = [];
      const keepNames = new Set<string>();
      for (const t of currentTools) {
        const name = t && t.function && typeof t.function.name === 'string' ? String(t.function.name) : '';
        const lower = name.toLowerCase();
        if (!name) { outTools.push(t); continue; }
        if (lower === 'list_mcp_resources') {
          // Keep list; ensure parameters shape (server optional)
          const def = { type: 'function', function: { name: 'list_mcp_resources', strict: true, description: t.function?.description || 'List resources from a given MCP server.', parameters: objSchema({ server: serverProp, filter: { type: 'string' }, root: { type: 'string' } }, [] /* server optional */) } };
          outTools.push(def); keepNames.add('list_mcp_resources');
          continue;
        }
        if (lower === 'read_mcp_resource' || lower === 'list_mcp_resource_templates') {
          if (serverList.length > 0) {
            // Keep only when servers known; normalize parameters
            if (lower === 'read_mcp_resource') {
              const def = { type: 'function', function: { name: 'read_mcp_resource', strict: true, description: t.function?.description || 'Read a resource via MCP server.', parameters: objSchema({ server: serverProp, uri: { type: 'string' } }, ['server','uri']) } };
              outTools.push(def); keepNames.add('read_mcp_resource');
            } else {
              const def = { type: 'function', function: { name: 'list_mcp_resource_templates', strict: true, description: t.function?.description || 'List resource templates via MCP server.', parameters: objSchema({ server: serverProp }, ['server']) } };
              outTools.push(def); keepNames.add('list_mcp_resource_templates');
            }
          }
          continue;
        }
        // Non-MCP tools: keep as-is
        outTools.push(t);
      }
      // Ensure list exists at least once
      if (!keepNames.has('list_mcp_resources')) {
        outTools.push({ type: 'function', function: { name: 'list_mcp_resources', strict: true, description: 'List resources from a given MCP server (arguments.server = server label).', parameters: objSchema({ server: serverProp, filter: { type: 'string' }, root: { type: 'string' } }, [] /* server optional */) } });
      }
      // When servers known, ensure read/templates exist
      if (serverList.length > 0) {
        if (!keepNames.has('read_mcp_resource')) {
          outTools.push({ type: 'function', function: { name: 'read_mcp_resource', strict: true, description: 'Read a resource via MCP server.', parameters: objSchema({ server: serverProp, uri: { type: 'string' } }, ['server','uri']) } });
        }
        if (!keepNames.has('list_mcp_resource_templates')) {
          outTools.push({ type: 'function', function: { name: 'list_mcp_resource_templates', strict: true, description: 'List resource templates via MCP server.', parameters: objSchema({ server: serverProp }, ['server']) } });
        }
      }
      (normalized as any).tools = outTools;

      // No system tips for MCP on OpenAI Chat path (avoid leaking tool names)
    }
  } catch { /* ignore MCP injection */ }

  // Inject minimal system tool guidance when enabled
  try {
    const sysGuideEnabled = String(process.env.RCC_SYSTEM_TOOL_GUIDANCE ?? '1').trim() !== '0';
    const msgs = Array.isArray((normalized as any).messages) ? ((normalized as any).messages as any[]) : [];
    const tools = Array.isArray((normalized as any).tools) ? ((normalized as any).tools as any[]) : [];
    const hasGuidance = msgs.some((m: any) => m && m.role === 'system' && typeof m.content === 'string' && /Use OpenAI tool_calls|Tool usage guidance/i.test(m.content));
    if (sysGuideEnabled && !hasGuidance && tools.length > 0) {
      const sys = buildSystemToolGuidance();
      (normalized as any).messages = [ { role: 'system', content: sys }, ...msgs ];
    }
  } catch { /* ignore guidance injection */ }

  // Fix-up assistant.tool_calls for shell redirection/pipes: wrap argv into bash -lc when metachars present
  try {
    const msgs: any[] = Array.isArray((normalized as any).messages) ? ((normalized as any).messages as any[]) : [];
    const hasMetaToken = (arr: string[] | any): boolean => {
      const metas = new Set(['|','>','>>','<','<<',';','&&','||']);
      if (!Array.isArray(arr)) return false;
      return (arr as any[]).some((t) => metas.has(String(t)) || /[|<>;&]/.test(String(t)) || String(t).includes('&&') || String(t).includes('||') || String(t).includes('<<'));
    };
    const alreadyBashLc = (arr: any): boolean => Array.isArray(arr) && arr.length >= 2 && String(arr[0]) === 'bash' && String(arr[1]) === '-lc';
    const joinTokens = (tokens: any[]): string => tokens.map((t) => String(t)).join(' ');
    const splitCommandString = (input: string): string[] => {
      const s = String(input || '').trim();
      if (!s) return [];
      const out: string[] = [];
      let cur = '';
      let inSingle = false;
      let inDouble = false;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inSingle) { if (ch === "'") { inSingle = false; } else { cur += ch; } continue; }
        if (inDouble) { if (ch === '"') { inDouble = false; continue; } if (ch === '\\' && i + 1 < s.length) { i++; cur += s[i]; continue; } cur += ch; continue; }
        if (ch === "'") { inSingle = true; continue; }
        if (ch === '"') { inDouble = true; continue; }
        if (/\s/.test(ch)) { if (cur) { out.push(cur); cur=''; } continue; }
        cur += ch;
      }
      if (cur) out.push(cur);
      return out;
    };
    const flattenByComma = (arr: string[]): string[] => arr.flatMap((t) => String(t).split(',').map(s => s.trim()).filter(Boolean));
    const parseArrayPrefixToScript = (s: string): string | null => {
      try {
        const str = String(s || '').trim();
        if (!str.startsWith('[')) return null;
        let i = 0, depth = 0, inS = false, inD = false, esc = false, end = -1;
        for (; i < str.length; i++) {
          const ch = str[i];
          if (inS) { if (esc) { esc = false; continue; } if (ch === '\\') { esc = true; continue; } if (ch === "'") { inS = false; } continue; }
          if (inD) { if (esc) { esc = false; continue; } if (ch === '\\') { esc = true; continue; } if (ch === '"') { inD = false; } continue; }
          if (ch === "'") { inS = true; continue; }
          if (ch === '"') { inD = true; continue; }
          if (ch === '[') { depth++; continue; }
          if (ch === ']' && depth > 0) { depth--; if (depth === 0) { end = i; break; } continue; }
        }
        if (end < 0) return null;
        const arrPart = str.slice(0, end + 1);
        const rest = str.slice(end + 1).trim();
        let argv: any = null; try { argv = JSON.parse(arrPart); } catch { argv = null; }
        if (!Array.isArray(argv)) return null;
        const left = argv.map((x: any) => String(x)).join(' ');
        const script = left + (rest ? (' ' + rest) : '');
        return script.trim();
      } catch { return null; }
    };
    const stripBracketsAndCommas = (arr: string[]): string[] => arr
      .map((t) => t.replace(/^\[+/, '').replace(/\]+$/, ''))
      .map((t) => t.endsWith(',') ? t.slice(0, -1) : t)
      .filter((t) => t !== ',' && t.length > 0);
    const parseLenient = (value: any): any => {
      if (value === undefined || value === null) return {};
      if (typeof value === 'object') return value;
      if (typeof value !== 'string') return { _raw: String(value) };
      const s0 = value.trim();
      if (!s0) return {};
      try { return JSON.parse(s0); } catch { /* continue */ }
      const fence = s0.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      const candidate = fence ? fence[1] : s0;
      const objMatch = candidate.match(/\{[\s\S]*\}/);
      if (objMatch) { try { return JSON.parse(objMatch[0]); } catch { /* ignore */ } }
      const arrMatch = candidate.match(/\[[\s\S]*\]/);
      if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch { /* ignore */ } }
      let t = candidate.replace(/'([^']*)'/g, '"$1"');
      t = t.replace(/([{,\s])([A-Za-z_][A-Za-z0-9_-]*)\s*:/g, '$1"$2":');
      try { return JSON.parse(t); } catch { /* ignore */ }
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
    };
    for (const m of msgs) {
      if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
      m.tool_calls = m.tool_calls.map((tc: any) => {
        if (!tc || typeof tc !== 'object') return tc;
        const fn = tc.function || {};
        const name = typeof fn?.name === 'string' ? fn.name.toLowerCase() : undefined;
        const argStrIn = typeof fn?.arguments === 'string' ? fn.arguments : (fn?.arguments != null ? JSON.stringify(fn.arguments) : '{}');
        let argsObj: any = {};
        try { argsObj = parseLenient(argStrIn); } catch { argsObj = {}; }
        if (name === 'shell') {
          try {
            const cmdVal: any = (argsObj as any).command;
            if (typeof cmdVal === 'string') {
              const s = cmdVal.trim();
              const arrScript = parseArrayPrefixToScript(s);
              if (arrScript) {
                (argsObj as any).command = ['bash','-lc', arrScript];
              } else {
                const tokens = stripBracketsAndCommas(flattenByComma(splitCommandString(s)));
                if (tokens.length) {
                  if (hasMetaToken(tokens)) (argsObj as any).command = ['bash','-lc', tokens.join(' ')];
                  else (argsObj as any).command = tokens;
                } else {
                  (argsObj as any).command = [];
                }
              }
            } else if (Array.isArray(cmdVal)) {
              const toks = cmdVal.map((x: any) => String(x));
              if (!alreadyBashLc(toks) && hasMetaToken(toks)) (argsObj as any).command = ['bash','-lc', toks.join(' ')];
            }
          } catch { /* ignore */ }
        }
        try { fn.arguments = JSON.stringify(argsObj ?? {}); } catch { fn.arguments = argStrIn; }
        return { ...tc, function: fn };
      });
    }
    (normalized as any).messages = msgs;
  } catch { /* ignore shell fixups */ }

  // Unify tool result packaging for Chat path: ensure role:"tool" messages carry rcc.tool.v1 envelope
  try {
    const msgs: any[] = Array.isArray((normalized as any).messages) ? ((normalized as any).messages as any[]) : [];
    if (msgs.length) {
      const pending: string[] = [];
      const callById: Record<string, any> = {};
      const isImagePath = (p: any): boolean => {
        try {
          const s = String(p || '').toLowerCase();
          return /\.(png|jpg|jpeg|gif|webp|bmp|svg|tiff?|ico|heic|jxl)$/.test(s);
        } catch { return false; }
      };
      const buildRepairMessage = (name: string | undefined, args: any, body: any): string => {
        const allowed = ['shell','update_plan','view_image','list_mcp_resources'];
        const argStr = (() => { try { return JSON.stringify(args); } catch { return String(args); } })();
        const bodyText = typeof body === 'string' ? body : (() => { try { return JSON.stringify(body); } catch { return String(body); } })();
        const suggestions: string[] = [];
        // Missing or unknown tool name
        if (!name || name === 'tool' || name.trim() === '') {
          suggestions.push(
            'function.name 为空或未知。请选择以下之一: shell, update_plan, view_image, list_mcp_resources。'
          );
          // Heuristics
          if (args && typeof args === 'object' && ('command' in args)) {
            suggestions.push('检测到 arguments.command：你可能想调用 shell。');
          }
          if (args && typeof args === 'object' && ('plan' in args)) {
            suggestions.push('检测到 arguments.plan：你可能想调用 update_plan。');
          }
          if (args && typeof args === 'object' && isImagePath((args as any).path)) {
            suggestions.push('检测到图片路径：你可能想调用 view_image。');
          }
        }
        // view_image misuse
        if (name === 'view_image' && args && typeof args === 'object' && !isImagePath((args as any).path)) {
          suggestions.push('view_image 仅用于图片文件（png/jpg/gif/webp/svg/...）。当前路径看起来不是图片，请改用 shell: {"command":["cat","<path>"]} 来读取文本/markdown。');
        }
        // Common argument parse failures
        if (typeof bodyText === 'string' && /failed to parse function arguments|invalid type: string|expected a sequence/i.test(bodyText)) {
          suggestions.push('arguments 需要是单个 JSON 字符串。');
          suggestions.push('shell 推荐：数组 argv 或 bash -lc 字符串二选一。例如：');
          suggestions.push('  {"command":["find",".","-type","f","-name","*.md"]}');
          suggestions.push('  或 {"command":"bash -lc \"find . -type f -name \\\"*.md\\\" | head -20\""}');
        }
        // Always include quick examples
        suggestions.push('示例：shell 读取文件 → {"command":["cat","codex-local/docs/design.md"]}');
        suggestions.push('示例：update_plan → {"explanation":"...","plan":[{"step":"...","status":"in_progress"}]}');
        suggestions.push('示例：view_image → {"path":"/path/to/image.png"}');
        const header = '工具调用不可用（可自修复提示）';
        const why = `问题: ${bodyText}`;
        const given = `arguments: ${argStr}`;
        const allow = `允许工具: ${allowed.join(', ')}`;
        return [header, allow, given, ...suggestions, why].join('\n');
      };
      for (const m of msgs) {
        if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          for (const tc of m.tool_calls) {
            const id = typeof tc?.id === 'string' ? tc.id : undefined;
            if (id) { pending.push(id); callById[id] = tc; }
          }
        }
      }
      const toLenientObj = (v: any): any => {
        if (v && typeof v === 'object') return v;
        if (typeof v !== 'string') return v;
        const s = v.trim();
        if (!s) return '';
        // First, try strict JSON
        try { return JSON.parse(s); } catch { /* try fenced */ }
        const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (fence) { try { return JSON.parse(fence[1]); } catch { /* continue */ } }
        // Heuristic repair: common JSON-ish issues seen from model outputs
        try {
          let t = s;
          // 1) Replace single quotes with double quotes (non-greedy, content-safe best-effort)
          t = t.replace(/'([^']*)'/g, '"$1"');
          // 2) Quote unquoted keys (foo: bar -> "foo": bar)
          t = t.replace(/([{,\s])([A-Za-z_][A-Za-z0-9_-]*)\s*:/g, '$1"$2":');
          // 3) Quote bare request_id/call_id values (request_id: req_123 -> request_id: "req_123")
          t = t.replace(/("(?:request_id|call_id)"\s*:\s*)(req_[A-Za-z0-9_-]+)/g, '$1"$2"');
          // 4) Remove trailing commas before closing braces/brackets
          t = t.replace(/,\s*([}\]])/g, '$1');
          return JSON.parse(t);
        } catch { /* fallthrough */ }
        return s;
      };
      const toArray = (x: any): string[] => Array.isArray(x) ? x.map((t) => String(t)) : (typeof x === 'string' && x.length ? [x] : []);
      const trunc = (val: any, n = 800) => {
        try {
          const s = typeof val === 'string' ? val : JSON.stringify(val);
          return s.length > n ? s.slice(0, n) + '...(truncated)' : s;
        } catch { return String(val); }
      };
      const getReqId = (): string | null => {
        try {
          const meta = (normalized as any)._metadata || {};
          if (typeof meta?.requestId === 'string') return meta.requestId;
        } catch { /* ignore */ }
        return null;
      };
      for (const m of msgs) {
        if (!m || m.role !== 'tool') continue;
        const callId = typeof (m as any).tool_call_id === 'string' ? (m as any).tool_call_id : (pending.length ? pending.shift() : undefined);
        if (!callId) continue;
        const tc = callById[callId] || {};
        const fn = (tc && typeof tc === 'object') ? (tc.function || {}) : {};
        const name = typeof fn?.name === 'string' ? fn.name : 'tool';
        const argStr = typeof fn?.arguments === 'string' ? fn.arguments : (fn?.arguments != null ? JSON.stringify(fn.arguments) : undefined);
        let argsOut: any = {};
        try { argsOut = argStr ? JSON.parse(argStr) : {}; } catch { argsOut = argStr ? { _raw: argStr } : {}; }
        const rawContent = (m as any).content;
        const body = toLenientObj(rawContent);
        // Helper: sanitize oversized outputs and redact heredoc writes
        const sanitizeEnvelope = (env: any): any => {
          try {
            const LIM = Math.max(1, Number((process as any)?.env?.ROUTECODEX_TOOL_OUTPUT_LIMIT || (process as any)?.env?.RCC_TOOL_OUTPUT_LIMIT || 1000));
            const trunc = (s: string): string => (typeof s === 'string' && s.length > LIM) ? (s.slice(0, LIM) + '...(truncated)') : s;
            const isWriteOp = (): boolean => {
              try {
                const cmd = (env?.executed?.command) as any;
                if (Array.isArray(cmd) && cmd.length >= 1) {
                  const t0 = String(cmd[0] || '').toLowerCase();
                  if (t0 === 'bash' && String(cmd[1] || '').toLowerCase() === '-lc') {
                    const script = String(cmd[2] || '');
                    const low = script.toLowerCase();
                    return (low.includes('cat >') && low.includes('<<')) || low.includes('*** begin patch');
                  }
                  const tokens = cmd.map((x: any) => String(x).toLowerCase());
                  return (tokens.includes('cat') && (tokens.includes('>') || tokens.includes('>>'))) || tokens.includes('ed');
                }
                return false;
              } catch { return false; }
            };
            const redactHeredocInCommand = (): void => {
              try {
                const cmd = (env?.executed?.command) as any;
                if (Array.isArray(cmd) && cmd.length >= 3 && String(cmd[0]).toLowerCase() === 'bash' && String(cmd[1]).toLowerCase() === '-lc') {
                  const script = String(cmd[2] || '');
                  if (script.length > LIM || /<<|\*\*\* Begin Patch/i.test(script)) {
                    (env.executed as any).command[2] = `[heredoc/patch script suppressed: ~${script.length} chars]`;
                  }
                }
              } catch { /* ignore */ }
            };
            const sanitizeResult = (): void => {
              try {
                if (!env.result || typeof env.result !== 'object') return;
                const r = env.result as any;
                if (typeof r.stdout === 'string') r.stdout = trunc(r.stdout);
                if (typeof r.stderr === 'string') r.stderr = trunc(r.stderr);
                if (typeof r.output === 'string') {
                  r.output = trunc(r.output);
                } else if (r.output && typeof r.output === 'object') {
                  const o = r.output as any;
                  if (typeof o.output === 'string') o.output = trunc(o.output);
                }
              } catch { /* ignore */ }
            };

            if (isWriteOp()) {
              // Do not echo write scripts or bodies at all
              try {
                // executed: drop command tokens to avoid being mimicked by the model
                if (env.executed && typeof env.executed === 'object') {
                  try { (env.executed as any).command = []; } catch { /* ignore */ }
                }
                // arguments: remove command field from tool result envelope to avoid echo
                if (env.arguments && typeof env.arguments === 'object') {
                  try { delete (env.arguments as any).command; } catch { /* ignore */ }
                }
                // result: clear output; keep stderr/stdout snippets for diagnostics
                if (env.result && typeof env.result === 'object') {
                  const r = env.result as any;
                  r.output = '';
                  // keep exit_code/duration; limit stdout/stderr length
                  if (typeof r.stdout === 'string') r.stdout = trunc(r.stdout);
                  if (typeof r.stderr === 'string') r.stderr = trunc(r.stderr);
                  if ('truncated' in r) delete r.truncated;
                }
              } catch { /* ignore */ }
            } else {
              sanitizeResult();
            }
          } catch { /* ignore all */ }
          return env;
        };

        // If already conforms to rcc.tool.v1, normalize minor field variants then keep
        if (body && typeof body === 'object' && (body as any).version === 'rcc.tool.v1' && (body as any).tool && (body as any).result) {
          try { sanitizeEnvelope(body); } catch { /* ignore */ }
          try {
            // Normalize common typos/variants: execed -> executed
            if ((body as any).execed && !(body as any).executed) {
              (body as any).executed = (body as any).execed;
              delete (body as any).execed;
            }
            // Ensure meta.request_id is a string when present
            if ((body as any).meta && typeof (body as any).meta === 'object' && (body as any).meta.request_id != null) {
              const rid = (body as any).meta.request_id;
              if (typeof rid !== 'string') {
                try { (body as any).meta.request_id = String(rid); } catch { /* ignore */ }
              }
            }
          } catch { /* ignore */ }
          // Ensure tool_call_id is set
          (m as any).tool_call_id = callId;
          if (typeof (m as any).content !== 'string') { try { (m as any).content = JSON.stringify(body); } catch { (m as any).content = String((m as any).content); } }
          try { console.log('[LLMSWITCH][tool-output][before-kept]', { callId, name, content: trunc(rawContent) }); } catch {}
          continue;
        }
        const cmd = (argsOut && typeof argsOut === 'object') ? (argsOut as any).command : undefined;
        const workdir = (argsOut && typeof argsOut === 'object') ? (argsOut as any).workdir : undefined;
        const meta: any = (body && typeof body === 'object') ? ((body as any).metadata || (body as any).meta || {}) : {};
        const exitCode = (body && typeof (body as any).exit_code === 'number') ? (body as any).exit_code
          : (typeof meta.exit_code === 'number' ? meta.exit_code : undefined);
        const duration = (body && typeof (body as any).duration_seconds === 'number') ? (body as any).duration_seconds
          : (typeof meta.duration_seconds === 'number' ? meta.duration_seconds : undefined);
        const stdout = (body && typeof (body as any).stdout === 'string') ? (body as any).stdout : undefined;
        let stderr = (body && typeof (body as any).stderr === 'string') ? (body as any).stderr
          : ((body && typeof (body as any).error === 'string') ? (body as any).error : undefined);
        let bodyLocal: any = body;
        const unsupportedStr = (typeof bodyLocal === 'string') && /^unsupported call/i.test(bodyLocal.trim());
        let success = (bodyLocal && typeof (bodyLocal as any).success === 'boolean') ? (bodyLocal as any).success
          : (typeof exitCode === 'number' ? exitCode === 0 : undefined);
        // Structured self-repair hint on failures
        const missingName = !name || !String(name).trim() || name === 'tool';
        const parseFail = (typeof bodyLocal === 'string') && /failed to parse function arguments|invalid type: string|expected a sequence/i.test(String(bodyLocal));
        const misuseViewImage = name === 'view_image' && (argsOut && typeof argsOut === 'object') && !isImagePath((argsOut as any).path);
        if (unsupportedStr || missingName || parseFail || misuseViewImage) {
          success = false;
          const hint = buildRepairMessage(name, argsOut, bodyLocal);
          stderr = hint;
          // Also override body so downstream minimal mappers can surface detailed hint
          try { bodyLocal = { error: 'tool_call_invalid', hint }; } catch { /* ignore */ }
        }
        const reqId = getReqId();
        const successBool = (typeof success === 'boolean') ? success : (typeof exitCode === 'number' ? exitCode === 0 : false);
        let envelope: any = {
          version: 'rcc.tool.v1',
          tool: { name, call_id: callId },
          arguments: argsOut,
          executed: { command: toArray(cmd), ...(typeof workdir === 'string' && workdir ? { workdir } : {}) },
          result: {
            success: successBool,
            ...(typeof exitCode === 'number' ? { exit_code: exitCode } : {}),
            ...(typeof duration === 'number' ? { duration_seconds: duration } : {}),
            ...(typeof stdout === 'string' ? { stdout } : {}),
            ...(typeof stderr === 'string' ? { stderr } : {}),
            output: bodyLocal
          },
          ...(reqId ? { meta: { request_id: reqId, ts: Date.now() } } : { meta: { ts: Date.now() } })
        };
        try { envelope = sanitizeEnvelope(envelope); } catch { /* ignore */ }
        try {
          console.log('[LLMSWITCH][tool-output][before]', { callId, name, content: trunc(rawContent) });
          console.log('[LLMSWITCH][tool-output][after]', {
            callId,
            name,
            result: {
              success: !!envelope.result?.success,
              exit_code: envelope.result?.exit_code,
              duration_seconds: envelope.result?.duration_seconds,
              stdout: trunc(envelope.result?.stdout),
              stderr: trunc(envelope.result?.stderr),
            }
          });
        } catch {}
        try { (m as any).content = JSON.stringify(envelope); } catch { (m as any).content = String((m as any).content || ''); }
        (m as any).tool_call_id = callId;
      }
      (normalized as any).messages = msgs;
    }
  } catch { /* ignore tool message packaging errors */ }

  return normalized;
}

export function normalizeChatResponse(res: any): any {
  if (!res || typeof res !== 'object') return res;
  const out = { ...res };
  if (Array.isArray(out.choices)) {
    out.choices = out.choices.map((c: any) => {
      const choice = { ...c };
      const msg = choice.message && typeof choice.message === 'object' ? { ...choice.message } : choice.message;
      if (msg && typeof msg === 'object') {
        // 先从 assistant 文本中提取可能的工具调用（rcc.tool.v1 / *** Begin Patch ... *** End Patch）
        try {
          const hasNoToolCalls = (!(Array.isArray((msg as any).tool_calls)) || !(msg as any).tool_calls.length);
          if (typeof (msg as any).content === 'string' && hasNoToolCalls) {
            const text = String((msg as any).content);

            const extractRCCToolCallsFromText = (s: string): Array<{ id?: string; name: string; args: string }> | null => {
              try {
                if (typeof s !== 'string' || !s) return null;
                const out: Array<{ id?: string; name: string; args: string }> = [];
                const marker = /rcc\.tool\.v1/gi;
                let m: RegExpExecArray | null;
                while ((m = marker.exec(s)) !== null) {
                  let start = -1;
                  for (let i = m.index; i >= 0; i--) {
                    const ch = s[i];
                    if (ch === '{') { start = i; break; }
                    if (m.index - i > 4096) break;
                  }
                  if (start < 0) continue;
                  let depth = 0, end = -1; let inStr = false; let quote: string | null = null; let esc = false;
                  for (let j = start; j < s.length; j++) {
                    const ch = s[j];
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
                  const jsonStr = s.slice(start, end + 1);
                  let obj: any = null; try { obj = JSON.parse(jsonStr); } catch { obj = null; }
                  if (!obj || typeof obj !== 'object') continue;
                  if (String(obj.version || '').toLowerCase() !== 'rcc.tool.v1') continue;
                  const tool = obj.tool || {};
                  const name = typeof tool.name === 'string' && tool.name.trim() ? tool.name.trim() : undefined;
                  if (!name) continue;
                  const callId = typeof tool.call_id === 'string' && tool.call_id.trim() ? tool.call_id.trim() : undefined;
                  const argsObj = (obj.arguments !== undefined ? obj.arguments : {});
                  let argsStr = '{}'; try { argsStr = JSON.stringify(argsObj ?? {}); } catch { argsStr = '{}'; }
                  out.push({ id: callId, name, args: argsStr });
                  marker.lastIndex = end + 1;
                }
                return out.length ? out : null;
              } catch { return null; }
            };

            const extractApplyPatchCallsFromText = (s: string): Array<{ id?: string; name: string; args: string }> | null => {
              try {
                if (typeof s !== 'string' || !s) return null;
                const out: Array<{ id?: string; name: string; args: string }> = [];
                const candidates: string[] = [];
                const fenceRe = /```(?:patch)?\s*([\s\S]*?)\s*```/gi; let fm: RegExpExecArray | null;
                while ((fm = fenceRe.exec(s)) !== null) {
                  const body = fm[1] || '';
                  if (/\*\*\*\s+Begin Patch[\s\S]*?\*\*\*\s+End Patch/.test(body)) candidates.push(body);
                }
                if (/\*\*\*\s+Begin Patch[\s\S]*?\*\*\*\s+End Patch/.test(s)) candidates.push(s);
                const genId = () => `call_${Math.random().toString(36).slice(2, 10)}`;
                for (const src of candidates) {
                  const pg = /\*\*\*\s+Begin Patch[\s\S]*?\*\*\*\s+End Patch/gm; let pm: RegExpExecArray | null;
                  while ((pm = pg.exec(src)) !== null) {
                    const patch = pm[0]; if (!patch || patch.length < 32) continue;
                    let argsStr = '{}'; try { argsStr = JSON.stringify({ patch }); } catch { argsStr = '{"patch":""}'; }
                    out.push({ id: genId(), name: 'apply_patch', args: argsStr });
                  }
                }
                return out.length ? out : null;
              } catch { return null; }
            };

            const extractWriteFileCallsFromText = (s: string): Array<{ id?: string; name: string; args: string }> | null => {
              try {
                if (typeof s !== 'string' || !s) return null;
                const out: Array<{ id?: string; name: string; args: string }> = [];
                // Tolerant regex for <write_file><path>...</path><content>...</content></write_file>
                const re = /<write_file>\s*<path>([\s\S]*?)<\/path>\s*<content>([\s\S]*?)<\/content>\s*<\/write_file>/gi;
                let m: RegExpExecArray | null;
                while ((m = re.exec(s)) !== null) {
                  const rawPath = (m[1] || '').trim();
                  const rawContent = (m[2] || '');
                  if (!rawPath) continue;
                  const q = (x: string) => `'` + String(x).replace(/'/g, `\'`) + `'`;
                  const script = `cat > ${q(rawPath)} <<'EOF'\n${rawContent}\nEOF`;
                  const argsObj = { command: ['bash','-lc', script] } as any;
                  let argsStr = '{}'; try { argsStr = JSON.stringify(argsObj); } catch { argsStr = '{"command":["bash","-lc","true"]}'; }
                  out.push({ id: undefined, name: 'shell', args: argsStr });
                }
                return out.length ? out : null;
              } catch { return null; }
            };

            let handled = false;
            const rcc = extractRCCToolCallsFromText(text);
            if (rcc && rcc.length) {
              (msg as any).tool_calls = rcc.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.args } }));
              (msg as any).content = '';
              handled = true;
            }
            if (!handled) {
              const patches = extractApplyPatchCallsFromText(text);
              if (patches && patches.length) {
                (msg as any).tool_calls = patches.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.args } }));
                (msg as any).content = '';
                handled = true;
              }
            }
            if (!handled) {
              const writes = extractWriteFileCallsFromText(text);
              if (writes && writes.length) {
                (msg as any).tool_calls = writes.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.args } }));
                (msg as any).content = '';
                handled = true;
              }
            }
          }

          // 不在此处从 reasoning_content 做工具提取；该逻辑由 GLM 兼容层（glm-compatibility）负责
        } catch { /* ignore extraction errors */ }

        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          // Always normalize tool_calls
          msg.tool_calls = msg.tool_calls.map((tc: any) => normalizeToolCall(tc));
          // Preserve assistant textual content when present (flatten arrays), instead of forcing empty
          if (typeof msg.content === 'string') {
            // keep as-is
          } else if (Array.isArray(msg.content)) {
            const parts = (msg.content as any[])
              .map((p: any) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
              .filter((s: string) => !!s.trim());
            msg.content = parts.join('\n');
          } else if (msg.content === undefined || msg.content === null) {
            msg.content = '';
          }
        } else if (Array.isArray(msg.content)) {
          const parts = msg.content
            .map((p: any) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
            .filter((s: string) => !!s.trim());
          msg.content = parts.join('\n');
        } else if (msg.content === undefined || msg.content === null) {
          msg.content = '';
        }
        choice.message = msg;
      }
      return choice;
    });
  }
  return out;
}

function normalizeMessage(message: any): any {
  if (!message || typeof message !== 'object') return message;
  const normalizedMessage = { ...message };

  if (normalizedMessage.content === undefined || normalizedMessage.content === null) {
    normalizedMessage.content = '';
  } else if (typeof normalizedMessage.content === 'string') {
    // ok
  } else if (Array.isArray(normalizedMessage.content)) {
    // keep structured array
  } else if (typeof normalizedMessage.content === 'object') {
    // keep structured object
  } else {
    normalizedMessage.content = String(normalizedMessage.content);
  }

  if (normalizedMessage.role === 'assistant' && Array.isArray(normalizedMessage.tool_calls)) {
    normalizedMessage.tool_calls = normalizedMessage.tool_calls.map((toolCall: any) => normalizeToolCall(toolCall));
  }

  return normalizedMessage;
}

function normalizeTool(tool: any): any {
  if (!tool || typeof tool !== 'object') return tool;
  const normalizedTool = { ...tool };
  if (normalizedTool.type === 'function' && normalizedTool.function) {
    const fn = { ...normalizedTool.function };
    if (fn.parameters && typeof fn.parameters !== 'object') {
      try { fn.parameters = JSON.parse(String(fn.parameters)); } catch { fn.parameters = {}; }
    }
    normalizedTool.function = fn;
  }
  return normalizedTool;
}

function normalizeToolCall(tc: any): any {
  if (!tc || typeof tc !== 'object') return tc;
  const t = { ...tc };
  if (t.function && typeof t.function === 'object') {
    const fn = { ...t.function };
    const argStrIn = typeof fn.arguments === 'string' ? fn.arguments : (fn.arguments != null ? JSON.stringify(fn.arguments) : '{}');
    let argsObj: any = {};
    try { argsObj = JSON.parse(argStrIn); } catch { argsObj = {}; }

    // Drop dotted-name prefix unconditionally; keep only base function name
    if (typeof fn.name === 'string' && fn.name.includes('.')) {
      const dot = fn.name.indexOf('.');
      fn.name = fn.name.slice(dot + 1).trim();
    }

    // Do not infer missing/empty function name; preserve as-is for client to correct

    // Shell command coercion (generic, no command-specific behavior):
    // - If command is string and contains shell metacharacters (>, >>, <, <<, |, ;, &&, ||), wrap with bash -lc
    // - Otherwise, split into argv tokens safely and avoid bash -lc to prevent quoting issues
    if (String(fn.name || '').toLowerCase() === 'shell') {
      const cmdVal: any = (argsObj as any)?.command;
      if (typeof cmdVal === 'string' && cmdVal.trim().length > 0) {
        const s = cmdVal.trim();
        const hasMeta = /[<>|;&]/.test(s) || s.includes('&&') || s.includes('||') || s.includes('<<');
        const splitCommandString = (input: string): string[] => {
          const str = input.trim();
          if (!str) return [];
          const out: string[] = [];
          let cur = '';
          let inSingle = false;
          let inDouble = false;
          for (let i = 0; i < str.length; i++) {
            const ch = str[i];
            if (inSingle) { if (ch === "'") { inSingle = false; } else { cur += ch; } continue; }
            if (inDouble) {
              if (ch === '"') { inDouble = false; continue; }
              if (ch === '\\' && i + 1 < str.length) { i++; cur += str[i]; continue; }
              cur += ch; continue;
            }
            if (ch === "'") { inSingle = true; continue; }
            if (ch === '"') { inDouble = true; continue; }
            if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
            cur += ch;
          }
          if (cur) out.push(cur);
          return out;
        };
        if (hasMeta) {
          (argsObj as any).command = ['bash', '-lc', s];
        } else {
          (argsObj as any).command = splitCommandString(s);
        }
      }
    }

    // Ensure arguments is a JSON string per OpenAI schema
    try { fn.arguments = JSON.stringify(argsObj); } catch { fn.arguments = argStrIn; }
    t.function = fn;
  }
  return t;
}
import { buildSystemToolGuidance } from '../../guidance/index.js';
