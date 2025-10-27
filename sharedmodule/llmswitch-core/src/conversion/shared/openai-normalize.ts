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
    // Drop dotted-name prefix unconditionally; keep only base function name
    if (typeof fn.name === 'string' && fn.name.includes('.')) {
      const dot = fn.name.indexOf('.');
      fn.name = fn.name.slice(dot + 1).trim();
    }
    if (fn.arguments !== undefined && typeof fn.arguments !== 'string') {
      try { fn.arguments = JSON.stringify(fn.arguments); } catch { fn.arguments = String(fn.arguments); }
    }
    t.function = fn;
  }
  return t;
}
