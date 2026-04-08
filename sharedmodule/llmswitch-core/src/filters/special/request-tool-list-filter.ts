import type { Filter, FilterContext, FilterResult, JsonObject } from '../types.js';

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logRequestToolListFilterNonBlockingError(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  try {
    const suffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(
      `[request-tool-list-filter] ${stage} failed (non-blocking): ${formatUnknownError(error)}${suffix}`
    );
  } catch {
    void 0;
  }
}

function envMode(): 'phase'|'all'|'off' {
  const v = String(process?.env?.RCC_MCP_EXPOSE || '').toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return 'off';
  if (v === 'all') return 'all';
  return 'phase';
}

function getEnvServers(): string[] {
  const raw = String(process?.env?.RCC_MCP_SERVERS || '').trim();
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function extractMcpServerLabelsFromOutput(output: unknown): string[] {
  const found: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string') {
      const s = v.trim();
      if (s) found.push(s);
    }
  };

  try {
    if (Array.isArray(output)) {
      for (const item of output) {
        if (typeof item === 'string') add(item);
        else if (isObject(item)) add((item as any).server);
      }
      return found;
    }

    if (!isObject(output)) return found;

    // Common aggregator shapes:
    // - { servers: ["context7", ...] }
    // - { resources: [{ server: "..." }, ...] }
    // - { resourceTemplates: [{ server: "..." }, ...] }
    const servers = (output as any).servers;
    if (Array.isArray(servers)) {
      for (const s of servers) add(s);
    }

    const resources = (output as any).resources;
    if (Array.isArray(resources)) {
      for (const r of resources) {
        if (!isObject(r)) continue;
        add((r as any).server);
        add((r as any).source?.server);
      }
    }

    const templates = (output as any).resourceTemplates;
    if (Array.isArray(templates)) {
      for (const t of templates) {
        if (!isObject(t)) continue;
        add((t as any).server);
        add((t as any).source?.server);
      }
    }
  } catch (extractError) {
    logRequestToolListFilterNonBlockingError('extractMcpServerLabelsFromOutput', extractError);
  }

  return found;
}

function collectServersFromMessages(messages: any[]): string[] {
  const out = new Set<string>();
  try {
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      const role = String((m as any).role || '').toLowerCase();
      if (role !== 'tool') continue;

      const c = (m as any).content;
      if (typeof c !== 'string' || c.trim().length === 0) continue;

      // IMPORTANT: Only trust tool *results* (not assistant guesses in tool_calls).
      // Extract server labels only from rcc.tool.v1 envelope outputs for list_mcp_resources.
      try {
        const parsed = JSON.parse(c);
        if (!parsed || typeof parsed !== 'object') continue;

        // rcc.tool.v1 envelope: { version, tool:{name}, result:{output} }
        if (parsed.version === 'rcc.tool.v1' && parsed.tool && typeof parsed.tool.name === 'string') {
          const toolName = String(parsed.tool.name).toLowerCase();
          if (toolName !== 'list_mcp_resources') continue;
          const output = parsed.result?.output;
          for (const s of extractMcpServerLabelsFromOutput(output)) out.add(s);
          continue;
        }

        // Fallback: some environments may return raw shapes (no envelope).
        // Only accept when output clearly advertises server labels, not echoed arguments.
        for (const s of extractMcpServerLabelsFromOutput((parsed as any).output ?? parsed)) out.add(s);
      } catch (parseError) {
        logRequestToolListFilterNonBlockingError('collectServersFromMessages.parseMessageContent', parseError);
      }
    }
  } catch (collectError) {
    logRequestToolListFilterNonBlockingError('collectServersFromMessages', collectError);
  }
  return Array.from(out);
}

function detectEmptyMcpListFromMessages(messages: any[]): boolean {
  try {
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      const role = String((m as any).role || '').toLowerCase();
      if (role !== 'tool') continue;

      const c = (m as any).content;
      if (typeof c !== 'string' || c.trim().length === 0) continue;

      const lowered = c.toLowerCase();
      // Some clients surface MCP "resources/list" unsupported as a plain error string.
      if (lowered.includes('-32601') || (lowered.includes('method') && lowered.includes('not found'))) {
        return true;
      }

      try {
        const parsed: any = JSON.parse(c);
        if (!parsed || typeof parsed !== 'object') continue;

        // rcc.tool.v1 envelope: { version, tool:{name}, result:{output} }
        if (parsed.version === 'rcc.tool.v1' && parsed.tool && typeof parsed.tool.name === 'string') {
          const toolName = String(parsed.tool.name).toLowerCase();
          if (toolName !== 'list_mcp_resources') continue;
          const out = parsed.result?.output;
          if (Array.isArray(out) && out.length === 0) return true;
          if (out && typeof out === 'object' && Array.isArray((out as any).resources) && (out as any).resources.length === 0) {
            return true;
          }
          if (out && typeof out === 'object' && Array.isArray((out as any).servers) && (out as any).servers.length === 0) {
            return true;
          }
          continue;
        }

        // Fallback: raw shapes (no envelope).
        const payload = (parsed as any).output ?? parsed;
        if (payload && typeof payload === 'object') {
          if (Array.isArray((payload as any).resources) && (payload as any).resources.length === 0) return true;
          if (Array.isArray((payload as any).servers) && (payload as any).servers.length === 0) return true;
          const err = (payload as any).error ?? (parsed as any).error;
          if (err && typeof err === 'object') {
            const code = (err as any).code;
            const msg = typeof (err as any).message === 'string' ? String((err as any).message).toLowerCase() : '';
            if (code === -32601 || msg.includes('method not found')) return true;
          }
        }
      } catch (parseError) {
        logRequestToolListFilterNonBlockingError('detectEmptyMcpListFromMessages.parseMessageContent', parseError);
      }
    }
  } catch (detectError) {
    logRequestToolListFilterNonBlockingError('detectEmptyMcpListFromMessages', detectError);
  }
  return false;
}

function ensureFunctionTool(tools: any[], name: string, description: string, parameters: any): void {
  const idx = tools.findIndex(t => t && typeof t === 'object' && t.type === 'function' && t.function && t.function.name === name);
  if (idx >= 0) {
    const cur = tools[idx];
    const fn = (cur.function = cur.function || {});
    fn.name = name;
    if (typeof fn.description !== 'string' || !String(fn.description).trim()) fn.description = description;
    fn.parameters = parameters;
  } else {
    tools.push({ type: 'function', function: { name, description, parameters } });
  }
}

function removeToolByName(tools: any[], name: string): void {
  for (let i = tools.length - 1; i >= 0; i--) {
    const t = tools[i];
    if (t && typeof t === 'object' && t.type === 'function' && t.function && t.function.name === name) {
      tools.splice(i, 1);
    }
  }
}

/**
 * RequestToolListFilter (request_pre)
 * - Generic tool-list filter/augment hook
 * - Currently only handles MCP tools with phase-based exposure
 */
export class RequestToolListFilter implements Filter<JsonObject> {
  readonly name = 'request_tool_list_filter';
  readonly stage: FilterContext['stage'] = 'request_pre';

  apply(input: JsonObject, ctx: FilterContext): FilterResult<JsonObject> {
    try {
      const out = JSON.parse(JSON.stringify(input || {}));
      const hadIncomingTools = Array.isArray((out as any).tools);
      const tools = hadIncomingTools ? ((out as any).tools as any[]) : [];
      if (!hadIncomingTools) {
        (out as any).tools = tools;
      }

      const mode = envMode();
      if (mode === 'off') {
        if (!hadIncomingTools && tools.length === 0) {
          delete (out as any).tools;
        }
        return { ok: true, data: out };
      }

      const messages = Array.isArray((out as any).messages) ? ((out as any).messages as any[]) : [];
      const servers = new Set<string>();
      for (const s of getEnvServers()) servers.add(s);
      for (const s of collectServersFromMessages(messages)) servers.add(s);
      const knownServers = Array.from(servers);
      const mcpListEmpty = detectEmptyMcpListFromMessages(messages);
      const formatKnownServers = (list: string[]): string => {
        if (!Array.isArray(list) || list.length === 0) return '';
        const shown = list.slice(0, 8);
        const suffix = list.length > shown.length ? ` (+${list.length - shown.length} more)` : '';
        return `Known MCP servers: ${shown.join(', ')}${suffix}.`;
      };
      const mcpServerReminder =
        'Note: arguments.server is an MCP server label (NOT a tool name like shell/exec_command/apply_patch).';

      // If the session already attempted list_mcp_resources and got an empty/unsupported response,
      // stop exposing MCP *resource* tools to avoid repeated "server" probing loops.
      if (mcpListEmpty) {
        removeToolByName(tools, 'list_mcp_resources');
        removeToolByName(tools, 'list_mcp_resource_templates');
        removeToolByName(tools, 'read_mcp_resource');
        (out as any).tools = tools;
        return { ok: true, data: out };
      }

      // MCP tool schemas
      const listResParams: any = {
        type: 'object',
        properties: {
          server: knownServers.length > 0 ? { type: 'string', enum: knownServers, minLength: 1 } : { type: 'string', minLength: 1 },
          filter: { type: 'string' },
          root: { type: 'string' }
        },
        additionalProperties: false
      };
      const listTplParams: any = {
        type: 'object',
        properties: {
          cursor: { type: 'string' },
          server: knownServers.length > 0 ? { type: 'string', enum: knownServers, minLength: 1 } : { type: 'string', minLength: 1 }
        },
        additionalProperties: false
      };
      const readResParamsBase = {
        type: 'object',
        properties: {
          server: { type: 'string' },
          uri: { type: 'string' }
        },
        required: ['server', 'uri'],
        additionalProperties: false
      } as any;

      const listDescription = [
        'List resources exposed by MCP servers.',
        'Only use this for MCP resources (not MCP tools). Many MCP servers expose tools only; if the result is empty, do not retry.',
        'If you do not know the MCP server name yet, call this tool with {} once; then reuse the returned server names for subsequent calls.',
        mcpServerReminder,
        formatKnownServers(knownServers)
      ].filter(Boolean).join('\n');
      const templatesDescription = [
        'List resource templates exposed by MCP servers.',
        'Only use this for MCP resources (not MCP tools). If list_mcp_resources returns empty, do not retry.',
        'If you do not know the MCP server name yet, call list_mcp_resources({}) once first.',
        mcpServerReminder,
        formatKnownServers(knownServers)
      ].filter(Boolean).join('\n');
      const readDescription = [
        'Read a specific MCP resource by { server, uri }.',
        'Only use this for MCP resources (not MCP tools). If list_mcp_resources returns empty, do not retry.',
        'If you do not know the MCP server name yet, call list_mcp_resources({}) once first.',
        mcpServerReminder,
        formatKnownServers(knownServers)
      ].filter(Boolean).join('\n');

      if (mode === 'all') {
        ensureFunctionTool(tools, 'list_mcp_resources', listDescription, listResParams);
        ensureFunctionTool(tools, 'list_mcp_resource_templates', templatesDescription, listTplParams);
        ensureFunctionTool(tools, 'read_mcp_resource', readDescription, readResParamsBase);
      } else {
        // phase
        ensureFunctionTool(tools, 'list_mcp_resources', listDescription, listResParams);
        ensureFunctionTool(tools, 'list_mcp_resource_templates', templatesDescription, listTplParams);
        // read is only exposed when we have known servers
        if (knownServers.length > 0) {
          const withEnum = JSON.parse(JSON.stringify(readResParamsBase));
          (withEnum as any).properties.server = { type: 'string', enum: knownServers };
          ensureFunctionTool(tools, 'read_mcp_resource', readDescription, withEnum);
        } else {
          // remove any existing read tool to prevent premature exposure
          removeToolByName(tools, 'read_mcp_resource');
        }
      }

      (out as any).tools = tools;
      return { ok: true, data: out };
    } catch (applyError) {
      logRequestToolListFilterNonBlockingError('apply', applyError);
      return { ok: true, data: input };
    }
  }
}
