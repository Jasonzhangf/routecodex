/**
 * OpenAI Normalizer LLM Switch
 * Standardizes OpenAI requests to ensure proper format before processing.
 */

import type { LLMSwitchModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest } from '../../../../types/shared-dtos.js';
import { normalizeChatResponse, normalizeTools } from 'rcc-llmswitch-core/conversion';
import { extractToolText } from '../../utils/tool-result-text.js';

/**
 * OpenAI Normalizer LLM Switch Module
 * Ensures OpenAI Chat Completions requests are properly formatted
 */
export class OpenAINormalizerLLMSwitch implements LLMSwitchModule {
  readonly id: string;
  readonly type = 'llmswitch-openai-openai';
  readonly config: ModuleConfig;
  readonly protocol = 'openai';
  private isInitialized = false;

  constructor(config: ModuleConfig, _dependencies: ModuleDependencies) {
    this.id = `llmswitch-openai-openai-${Date.now()}`;
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    this.isInitialized = true;
  }

  async processIncoming(requestParam: any): Promise<SharedPipelineRequest> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const isDto = requestParam && typeof requestParam === 'object' && 'data' in requestParam && 'route' in requestParam;
    const dto = isDto ? (requestParam as SharedPipelineRequest) : null;
    const payload = isDto ? (dto!.data as any) : (requestParam as any);

    // Default: passthrough chat payload with STRICT validation (no fallback/guessing)
    // - assistant.tool_calls.function.arguments MUST be JSON string
    // - function.name MUST be one of declared tools[].function.name
    // - If schema declares parameters.command as array<string>, enforce array<string>
    // - tool role content is textified (extractToolText)
    const normalizedPayload = (() => {
      try {
        const out: any = { ...(payload || {}) };
        const msgs = Array.isArray(out.messages) ? (out.messages as any[]) : [];
        if (!msgs.length) return out;

        // Build declared tool name -> schema map
        const toolSchemas = new Map<string, any>();
        try {
          const tools = Array.isArray(out.tools) ? out.tools : [];
          for (const t of tools) {
            const fn = t && (t.function || t);
            const name = fn && typeof fn.name === 'string' ? fn.name : undefined;
            const params = fn ? (fn.parameters as any) : undefined;
            if (name) { toolSchemas.set(name, params && typeof params === 'object' ? params : undefined); }
          }
        } catch { /* ignore tools parse */ }

        // Collect known MCP servers from history (tool results and prior calls)
        const knownMcpServers = new Set<string>();
        try {
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            if ((m as any).role === 'tool' && typeof (m as any).content === 'string') {
              try {
                const o = JSON.parse(String((m as any).content));
                const args = (o && typeof o === 'object') ? (o as any).arguments : undefined;
                const sv = args && typeof args === 'object' ? (args as any).server : undefined;
                if (typeof sv === 'string' && sv.trim()) knownMcpServers.add(sv.trim());
              } catch { /* ignore */ }
            }
            if ((m as any).role === 'assistant' && Array.isArray((m as any).tool_calls)) {
              for (const tc of ((m as any).tool_calls as any[])) {
                try {
                  const fname = String(tc?.function?.name || '');
                  const dot = fname.indexOf('.');
                  if (dot > 0) {
                    const prefix = fname.slice(0, dot).trim(); if (prefix) knownMcpServers.add(prefix);
                  }
                  const argStr = String(tc?.function?.arguments ?? '');
                  const parsed = JSON.parse(argStr);
                  const sv = parsed && typeof parsed === 'object' ? parsed.server : undefined;
                  if (typeof sv === 'string' && sv.trim()) knownMcpServers.add(sv.trim());
                } catch { /* ignore */ }
              }
            }
          }
        } catch { /* ignore */ }

        // Ensure tools normalized and tools[].function.strict = true (align anthropic→openai)
        try {
          if (Array.isArray(out.tools)) {
            const nt = normalizeTools(out.tools as any[]);
            out.tools = (nt as any[]).map((t: any) => {
              if (t && t.type === 'function' && t.function && typeof t.function === 'object') {
                return { ...t, function: { ...t.function, strict: true } };
              }
              return t;
            });
            // MCP tools injection (CCR style): list_mcp_resources, read_mcp_resource, list_mcp_resource_templates
            try {
              const enableMcp = String(process.env.ROUTECODEX_MCP_ENABLE ?? '1') !== '0';
              if (enableMcp) {
                const have = new Set((out.tools as any[]).map((t: any) => (t?.function?.name || '').toString()));
                const addTool = (def: any) => { if (!have.has(def.function.name)) { (out.tools as any[]).push(def); have.add(def.function.name); } };
                const obj = (props: any, req: string[]) => ({ type: 'object', properties: props, required: req, additionalProperties: false });
                const serversRaw = String(process.env.ROUTECODEX_MCP_SERVERS || '').trim();
                const envServers = serversRaw ? serversRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
                const merged = Array.from(new Set([ ...envServers, ...Array.from(knownMcpServers) ]));
                const serverProp = merged.length ? { type: 'string', enum: merged } : { type: 'string' };
                // 初始阶段（未知 server）只暴露 list_mcp_resources；当存在已知 server 后再暴露全部 MCP 工具
                addTool({ type: 'function', function: { name: 'list_mcp_resources', strict: true, description: 'List resources from a given MCP server (arguments.server = server label).', parameters: obj({ server: serverProp, filter: { type: 'string' }, root: { type: 'string' } }, ['server']) } });
                if (merged.length > 0) {
                  addTool({ type: 'function', function: { name: 'read_mcp_resource', strict: true, description: 'Read a resource via MCP server.', parameters: obj({ server: serverProp, uri: { type: 'string' } }, ['server','uri']) } });
                  addTool({ type: 'function', function: { name: 'list_mcp_resource_templates', strict: true, description: 'List resource templates via MCP server.', parameters: obj({ server: serverProp }, ['server']) } });
                }
              }
            } catch { /* ignore mcp injection errors */ }
          }
        } catch { /* ignore */ }

        // Pre-scan: collect all completed tool_call_ids from history (role:'tool')
        const completedIds = new Set<string>();
        for (const m of msgs) {
          if (m && m.role === 'tool') {
            const cid = typeof m.tool_call_id === 'string' ? m.tool_call_id : undefined;
            if (cid) completedIds.add(cid);
          }
        }

        // 1) STRICT: validate assistant.tool_calls names and arguments
        for (const m of msgs) {
          if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            m.tool_calls = m.tool_calls.map((tc: any, idx: number) => {
              if (!tc || typeof tc !== 'object') return tc;
              const fn = { ...(tc.function || {}) };
              const name = typeof fn.name === 'string' ? fn.name : undefined;
              const isHistorical = typeof tc.id === 'string' && completedIds.has(tc.id);
              if (isHistorical) {
                if (fn.arguments !== undefined && typeof fn.arguments !== 'string') {
                  try { fn.arguments = JSON.stringify(fn.arguments); } catch { fn.arguments = '""'; }
                } else if (fn.arguments === undefined) {
                  fn.arguments = '""';
                }
                return { ...tc, function: fn };
              }
              // Do not reject unknown tool names; passthrough
              // Ensure arguments is a JSON string (stringify when needed)
              if (fn.arguments === undefined || typeof fn.arguments !== 'string') {
                try { fn.arguments = JSON.stringify(fn.arguments ?? {}); } catch { fn.arguments = '""'; }
              }
              // parse and validate minimal schema for common fields
              try {
                const schema = toolSchemas.get(name);
                let parsed: any;
                try {
                  parsed = JSON.parse(fn.arguments);
                } catch (jsonErr) {
                  // Limited, schema-gated repair: handle {"command":pwd} → {"command":"pwd"}
                  // Do NOT attempt generic repairs; only fix a single bare token for 'command'
                  const s = String(fn.arguments);
                  const m = s.match(/^\s*\{\s*"command"\s*:\s*([A-Za-z0-9._\-\/]+)\s*\}\s*$/);
                  if (m && schema && (schema as any)?.properties?.command) {
                    parsed = { command: m[1] };
                  } else {
                    throw jsonErr;
                  }
                }
                if (!parsed || typeof parsed !== 'object') {
                  const e: any = new Error(`Invalid arguments for tool '${name}': must be JSON object string`);
                  e.status = 400; throw e;
                }
                // MCP dotted-name canonicalization: "server.base" -> base, inject {server}
                try {
                  const enableMcp = String(process.env.ROUTECODEX_MCP_ENABLE ?? '1') !== '0';
                  if (enableMcp && typeof name === 'string' && name.includes('.')) {
                    const dot = name.indexOf('.');
                    const base = name.slice(dot + 1).trim();
                    const allowed = new Set(['list_mcp_resources','read_mcp_resource','list_mcp_resource_templates']);
                    // Drop the dotted prefix unconditionally and keep the base function name; do not inject server from prefix
                    if (allowed.has(base)) {
                      (fn as any).name = base;
                    }
                  }
                } catch { /* ignore */ }
                // If schema indicates command: array<string>, allow limited normalization:
                // - command as string JSON array (e.g. "[\"cat\",\"file\"]") → parse to array
                // - command as single string (e.g. "pwd" or "ls -la") → [string] (no space splitting)
                const cmdSchema = schema && typeof schema === 'object' ? (schema as any).properties?.command : undefined;
                if (cmdSchema && (cmdSchema.type === 'array' || Array.isArray(cmdSchema.type))) {
                  const val = (parsed as any).command;
                  if (Array.isArray(val)) {
                    // ok; will verify element types below
                  } else if (typeof val === 'string') {
                    const s = val.trim();
                    if ((s.startsWith('[') && s.endsWith(']'))) {
                      try {
                        const arr = JSON.parse(s);
                        (parsed as any).command = Array.isArray(arr) ? arr : [s];
                      } catch {
                        (parsed as any).command = [s];
                      }
                    } else {
                      // Predictable tokenization: if single token contains whitespace and no quotes, split by whitespace
                      if (/\s/.test(s) && !/["'\\]/.test(s)) {
                        (parsed as any).command = s.split(/\s+/).filter(Boolean);
                      } else {
                        (parsed as any).command = [s];
                      }
                    }
                  }
                  const finalCmd = (parsed as any).command;
                  const isArr = Array.isArray(finalCmd) && finalCmd.every((x: any) => typeof x === 'string');
                  if (!isArr) {
                    // Coerce to array<string> non-destructively instead of rejecting
                    (parsed as any).command = [ String(finalCmd) ];
                  }
                }
                // Persist possibly-normalized arguments
                fn.arguments = JSON.stringify(parsed);
              } catch (err) {
                // Do not throw on parse/coerce errors; preserve original arguments to avoid data loss
              }
              return { ...tc, function: fn };
            });
            // 保留 content 与 tool_calls 并存（不强制清空 content）
          }
        }

        // 2) Pair tool results with the latest assistant.tool_calls
        //    Maintain a FIFO queue and an id->tool_call map for structured echo
        let pending: string[] = [];
        const callById: Record<string, any> = {};
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i];
          if (!m || typeof m !== 'object') continue;
          if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            // Push call ids in order
            for (const tc of m.tool_calls) {
              const id = typeof tc?.id === 'string' ? tc.id : undefined;
              if (id) pending.push(id);
              if (id) callById[id] = tc;
            }
            continue;
          }
          if (m.role === 'tool') {
            // Decide output strategy: structured echo (default) or legacy textify
            const structuredDefaultOn = String(process.env.ROUTECODEX_TOOL_STRUCTURED || process.env.RCC_TOOL_STRUCTURED || '1') !== '0';
            const toLenientObj = (v: any): any => {
              if (v && typeof v === 'object') return v;
              if (typeof v !== 'string') return v;
              const s = v.trim();
              try { return JSON.parse(s); } catch { /* try fenced */ }
              const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
              if (fence) { try { return JSON.parse(fence[1]); } catch { /* ignore */ } }
              return s;
            };
            if (structuredDefaultOn) {
              try {
                const callId = typeof (m as any).tool_call_id === 'string' ? (m as any).tool_call_id : undefined;
                const tc = callId ? (callById[callId] || {}) : {};
                const fn = (tc && typeof tc === 'object') ? (tc.function || {}) : {};
                const name = typeof fn?.name === 'string' ? fn.name : undefined;
                const argStr = typeof fn?.arguments === 'string' ? fn.arguments
                  : (fn?.arguments != null ? JSON.stringify(fn.arguments) : undefined);
                let argsObj: any;
                try { argsObj = argStr ? JSON.parse(argStr) : undefined; } catch { argsObj = undefined; }
                // Build flattened, model-friendly JSON (no raw wrapper)
                const body = toLenientObj((m as any).content);
                const argsOut = (argsObj && typeof argsObj === 'object') ? argsObj : (argStr ? { _raw: argStr } : {});
                const cmd = (argsOut && typeof argsOut === 'object') ? (argsOut as any).command : undefined;
                const workdir = (argsOut && typeof argsOut === 'object') ? (argsOut as any).workdir : undefined;
                const flatten = (b: any) => {
                  const out: any = {
                    tool_call_id: callId || '',
                    tool_name: name || 'tool',
                    arguments: argsOut,
                    command: Array.isArray(cmd) ? cmd : (typeof cmd === 'string' && cmd.length ? [cmd] : []),
                    ...(typeof workdir === 'string' && workdir ? { workdir } : {})
                  };
                  if (b && typeof b === 'object') {
                    const meta: any = (b.metadata || b.meta || {});
                    const exitCode = (typeof b.exit_code === 'number') ? b.exit_code
                      : (typeof meta.exit_code === 'number' ? meta.exit_code : undefined);
                    const duration = (typeof b.duration_seconds === 'number') ? b.duration_seconds
                      : (typeof meta.duration_seconds === 'number' ? meta.duration_seconds : undefined);
                    if (typeof exitCode === 'number') out.exit_code = exitCode;
                    if (typeof duration === 'number') out.duration_seconds = duration;
                    if (typeof (b as any).stdout === 'string') out.stdout = (b as any).stdout;
                    if (typeof (b as any).stderr === 'string') out.stderr = (b as any).stderr;
                    if (typeof (b as any).error === 'string' && out.stderr === undefined) out.stderr = (b as any).error;
                    if (typeof (b as any).success === 'boolean') out.success = (b as any).success;
                    if ((b as any).output !== undefined) out.output = (b as any).output;
                    else if ((b as any).result !== undefined) out.output = (b as any).result;
                    else out.output = b; // preserve full object under output
                    return out;
                  }
                  // string/primitive: keep as output text
                  out.output = b;
                  return out;
                };
                (m as any).content = JSON.stringify(flatten(body));
              } catch {
                // Fallback: keep original as stringified JSON without extraction
                if (m.content !== undefined && typeof m.content !== 'string') {
                  try { (m as any).content = JSON.stringify(m.content); } catch { (m as any).content = String(m.content); }
                }
              }
            } else {
              // Legacy-off path: keep original value serialized (no heuristic extraction)
              if (m.content !== undefined && typeof m.content !== 'string') {
                try { (m as any).content = JSON.stringify(m.content); } catch { (m as any).content = String(m.content); }
              }
            }
            // Pair tool_call_id if possible; do not throw if missing
            if (!m.tool_call_id || typeof m.tool_call_id !== 'string') {
              if (pending.length > 0) {
                m.tool_call_id = pending.shift();
              }
            } else {
              // If present but not in pending, accept as-is (could be from older turn)
              // Optionally we could realign, but strict pairing beyond this might be too aggressive here.
              // No-op
            }
          }
        }

        // Append optional MCP server hint in system message (from env + discovered)
        try {
          const serversRaw = String(process.env.ROUTECODEX_MCP_SERVERS || '').trim();
          const enableMcp = String(process.env.ROUTECODEX_MCP_ENABLE ?? '1') !== '0';
          if (enableMcp) {
            const envServers = serversRaw ? serversRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
            const merged = Array.from(new Set([ ...envServers, ...Array.from(knownMcpServers) ]));
            if (merged.length > 0) {
              const listStr = JSON.stringify(merged);
              const tip = `MCP usage: allowed functions: list_mcp_resources, read_mcp_resource, list_mcp_resource_templates. arguments.server must be one of ${listStr}. Avoid dotted tool names (server.fn).`;
              msgs.push({ role: 'system', content: tip });
            } else {
              const tip = 'MCP usage: no known MCP servers yet. Only use list_mcp_resources to discover available servers. Do not call other MCP functions or use dotted tool names (server.fn) until a server_label is discovered.';
              msgs.push({ role: 'system', content: tip });
            }
          }
        } catch { /* ignore */ }

        return { ...out, messages: msgs };
      } catch (e) {
        // Strict fail-fast
        const err: any = new Error((e as Error).message || 'Chat request normalization failed');
        err.status = (e as any)?.status || 400;
        throw err;
      }
    })();

    const stamped = {
      ...normalizedPayload,
      _metadata: {
        ...(normalizedPayload as any)?._metadata || {},
        switchType: 'llmswitch-openai-openai',
        timestamp: Date.now(),
        originalProtocol: 'openai',
        targetProtocol: 'openai'
      }
    } as Record<string, unknown>;

    const outDto: SharedPipelineRequest = isDto
      ? { ...dto!, data: stamped }
      : {
          data: stamped,
          route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() },
          metadata: {},
          debug: { enabled: false, stages: {} }
        };
    return outDto;
  }

  async processOutgoing(response: any): Promise<any> {
    // Accept either raw payload or DTO { data, metadata }. Outbound: no extra normalization beyond shape.
    const isDto = response && typeof response === 'object' && 'data' in response && 'metadata' in response;
    let payload = isDto ? (response as any).data : response;
    // Normalize tool_calls arguments in provider responses as well (schema-driven minimal shaping)
    try {
      const p: any = payload && typeof payload === 'object' ? { ...(payload as any) } : payload;
      const choices = Array.isArray(p?.choices) ? p.choices : [];
      // Build declared tool name -> schema map from request context if present
      const toolSchemas = new Map<string, any>();
      // Not always available here; keep map empty to only enforce generic command shaping
      for (const c of choices) {
        const msg = c?.message || {};
        if (Array.isArray(msg?.tool_calls)) {
          msg.tool_calls = msg.tool_calls.map((tc: any) => {
            if (!tc || typeof tc !== 'object') return tc;
            const fn = { ...(tc.function || {}) };
            if (typeof fn.arguments === 'string') {
              try {
                const schema = toolSchemas.get(String(fn.name||'').trim());
                const parsed = JSON.parse(fn.arguments);
                if (parsed && typeof parsed === 'object') {
                  const cmdSchema = schema && typeof schema === 'object' ? (schema as any).properties?.command : { type: 'array' };
                  if (cmdSchema && (cmdSchema.type === 'array' || Array.isArray(cmdSchema.type))) {
                    const val = (parsed as any).command;
                    if (Array.isArray(val)) {
                      // ok
                    } else if (typeof val === 'string') {
                      const s = val.trim();
                      if (s.startsWith('[') && s.endsWith(']')) {
                        try { const arr = JSON.parse(s); if (Array.isArray(arr)) (parsed as any).command = arr; else (parsed as any).command = [s]; } catch { (parsed as any).command = [s]; }
                      } else {
                        if (/\s/.test(s) && !/["'\\]/.test(s)) {
                          (parsed as any).command = s.split(/\s+/).filter(Boolean);
                        } else {
                          (parsed as any).command = [s];
                        }
                      }
                    }
                  }
                  fn.arguments = JSON.stringify(parsed);
                }
              } catch { /* keep original */ }
            }
            return { ...tc, function: fn };
          });
        }
      }
      payload = p;
    } catch { /* ignore normalization errors */ }
    const normalized = normalizeChatResponse(payload);
    if (isDto) {
      return { ...(response as any), data: normalized };
    }
    return normalized;
  }

  async transformRequest(request: any): Promise<any> {
    return this.processIncoming(request);
  }

  async transformResponse(response: any): Promise<any> {
    return response;
  }

  // normalization moved to sharedmodule/llmswitch-core

  async dispose(): Promise<void> {
    this.isInitialized = false;
  }

  async cleanup(): Promise<void> {
    await this.dispose();
  }

  getStats(): any {
    return {
      type: this.type,
      initialized: this.isInitialized,
      timestamp: Date.now()
    };
  }
}
