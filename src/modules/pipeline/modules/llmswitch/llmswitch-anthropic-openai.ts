/**
 * Anthropic ↔ OpenAI LLMSwitch 实现
 * 基于配置驱动的双向协议转换
 */

import type { LLMSwitchModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../../types/shared-dtos.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import { normalizeArgsBySchema } from '../../utils/schema-arg-normalizer.js';
import {
  DEFAULT_CONVERSION_CONFIG,
  detectRequestFormat,
  detectResponseFormat,
  type ConversionConfig
} from './anthropic-openai-config.js';

export class AnthropicOpenAIConverter implements LLMSwitchModule {
  readonly id: string;
  readonly type = 'llmswitch-anthropic-openai';
  readonly protocol = 'bidirectional';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private logger: PipelineDebugLogger;
  private conversionConfig: ConversionConfig;
  private enableStreaming: boolean;
  private enableTools: boolean;
  private trustSchema: boolean;

  // Sticky tools/backfill is disabled per request: do not inject or cache tools

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.config = config;
    this.id = `llmswitch-anthropic-openai-${Date.now()}`;
    this.logger = dependencies.logger as any;
    this.conversionConfig = { ...DEFAULT_CONVERSION_CONFIG, ...(config.config?.conversionMappings || {}) };
    this.enableStreaming = config.config?.enableStreaming ?? true;
    this.enableTools = config.config?.enableTools ?? true;
    // When true, do not rename tool names or remap arguments; rely on provided tool schemas
    this.trustSchema = config.config?.trustSchema ?? true;
  }

  async initialize(): Promise<void> {
    this.logger.logModule(this.id, 'config-validation-success', {
      enableStreaming: this.enableStreaming,
      enableTools: this.enableTools,
      hasRequestMappings: !!this.conversionConfig.requestMappings,
      hasResponseMappings: !!this.conversionConfig.responseMappings
    });
    this.isInitialized = true;
  }

  async processIncoming(requestParam: SharedPipelineRequest): Promise<SharedPipelineRequest> {
    if (!this.isInitialized) { throw new Error('AnthropicOpenAIConverter is not initialized'); }
    const isDto = requestParam && typeof requestParam === 'object' && 'data' in requestParam && 'route' in requestParam;
    const dto = isDto ? (requestParam as SharedPipelineRequest) : null;
    const payload = isDto ? (dto!.data as any) : (requestParam as unknown as any);
    const requestFormat = detectRequestFormat(payload);

    if (requestFormat === 'anthropic') {
      // Debug presence of tools before conversion
      try {
        const toolsIn = Array.isArray((payload as any)?.tools) ? (payload as any).tools.length : 0;
        this.logger.logModule(this.id, 'tools-presence-before', { direction: 'anthropic->openai', toolsIn });
      } catch { /* ignore */ }

      let transformedRequest = this.convertAnthropicRequestToOpenAI(payload);
      // IMPORTANT: Do not perform sticky tool backfill/injection.
      // If caller omits tools this turn, we will NOT inject cached tools.

      this.logger.logTransformation(this.id, 'anthropic-to-openai-request', payload, transformedRequest);
      // Debug presence of tools after conversion
      try {
        const toolsOut = Array.isArray((transformedRequest as any)?.tools) ? (transformedRequest as any).tools.length : 0;
        this.logger.logModule(this.id, 'tools-presence-after', { direction: 'anthropic->openai', toolsOut });
      } catch { /* ignore */ }
      const out = {
        ...transformedRequest,
        _metadata: {
          switchType: this.type,
          direction: 'anthropic-to-openai',
          timestamp: Date.now(),
          originalFormat: 'anthropic',
          targetFormat: 'openai'
        }
      } as Record<string, unknown>;
      return isDto
        ? { ...dto!, data: out }
        : ({ data: out, route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } } as SharedPipelineRequest);
    }

    if (requestFormat === 'openai') {
      // Convert OpenAI-style request to Anthropic-style when selected switch is Anthropic
      const transformedRequest = this.convertOpenAIRequestToAnthropic(payload);
      this.logger.logTransformation(this.id, 'openai-to-anthropic-request', payload, transformedRequest);
      const out = {
        ...transformedRequest,
        _metadata: {
          switchType: this.type,
          direction: 'openai-to-anthropic',
          timestamp: Date.now(),
          originalFormat: 'openai',
          targetFormat: 'anthropic'
        }
      } as Record<string, unknown>;
      return isDto
        ? { ...dto!, data: out as any }
        : ({ data: out, route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } } as SharedPipelineRequest);
    }

    const passthrough = {
      ...payload,
      _metadata: {
        switchType: this.type,
        direction: 'passthrough',
        timestamp: Date.now(),
        originalFormat: requestFormat,
        targetFormat: requestFormat
      }
    } as Record<string, unknown>;
    return isDto
      ? { ...dto!, data: passthrough }
      : ({ data: passthrough, route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } } as SharedPipelineRequest);
  }

  async processOutgoing(responseParam: SharedPipelineResponse | any): Promise<SharedPipelineResponse | any> {
    if (!this.isInitialized) { throw new Error('AnthropicOpenAIConverter is not initialized'); }
    const isDto = responseParam && typeof responseParam === 'object' && 'data' in responseParam && 'metadata' in responseParam;
    let payload = isDto ? (responseParam as SharedPipelineResponse).data : responseParam;
    // Unwrap provider wrapper if present
    if (payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)) {
      const inner = (payload as Record<string, unknown>)['data'];
      if (inner && typeof inner === 'object' && (('choices' in (inner as Record<string, unknown>)) || ('content' in (inner as Record<string, unknown>)))) {
        payload = inner as unknown;
      }
    }
    const responseFormat = detectResponseFormat(payload);

    if (responseFormat === 'openai') {
      // Debug: presence of tool_calls in OpenAI response before conversion
      try {
        const toolCalls = Array.isArray((payload as any)?.choices?.[0]?.message?.tool_calls)
          ? (payload as any).choices[0].message.tool_calls.length
          : 0;
        this.logger.logModule(this.id, 'tools-presence-outgoing', { direction: 'openai->anthropic', toolCalls });
      } catch { /* ignore */ }
      const transformedResponse = this.convertOpenAIResponseToAnthropic(payload);
      this.logger.logTransformation(this.id, 'openai-to-anthropic-response', payload, transformedResponse);
      const out = {
        ...transformedResponse,
        _metadata: {
          ...(payload?._metadata || {}),
          switchType: this.type,
          direction: 'openai-to-anthropic',
          responseTimestamp: Date.now(),
          originalFormat: 'openai',
          targetFormat: 'anthropic'
        }
      } as Record<string, unknown>;
      return isDto ? { ...(responseParam as SharedPipelineResponse), data: out } : out;
    }

    const passthrough = {
      ...payload,
      _metadata: {
        ...(payload?._metadata || {}),
        switchType: this.type,
        direction: 'passthrough',
        responseTimestamp: Date.now(),
        originalFormat: responseFormat,
        targetFormat: responseFormat
      }
    } as Record<string, unknown>;
    return isDto ? { ...(responseParam as SharedPipelineResponse), data: passthrough } : passthrough;
  }

  async transformRequest(input: any): Promise<any> {
    // If DTO, delegate to processIncoming to keep DTO shape
    const isDto = input && typeof input === 'object' && 'data' in input && 'route' in input;
    if (isDto) { return this.processIncoming(input as SharedPipelineRequest); }
    // Plain object: convert plain→plain
    let payload = input as any;
    if (payload && typeof payload === 'object' && 'data' in payload) {
      const inner = (payload as Record<string, unknown>)['data'];
      if (inner && typeof inner === 'object' && (('choices' in (inner as Record<string, unknown>)) || ('content' in (inner as Record<string, unknown>)))) {
        payload = inner as unknown;
      }
    }
    const requestFormat = detectRequestFormat(payload);
    if (requestFormat === 'anthropic') {
      return this.convertAnthropicRequestToOpenAI(payload);
    }
    if (requestFormat === 'openai') {
      return this.convertOpenAIRequestToAnthropic(payload);
    }
    return payload;
  }

  async transformResponse(input: any): Promise<any> {
    // If DTO, delegate to processOutgoing to keep DTO shape
    const isDto = input && typeof input === 'object' && 'data' in input && 'metadata' in input;
    if (isDto) { return this.processOutgoing(input as SharedPipelineResponse); }
    // Plain object: convert plain→plain
    const payload = input as any;
    const responseFormat = detectResponseFormat(payload);
    if (responseFormat === 'openai') {
      const out = this.convertOpenAIResponseToAnthropic(payload);
      return out;
    }
    return payload;
  }

  private convertAnthropicRequestToOpenAI(request: any): any {
    const { requestMappings } = this.conversionConfig;
    const transformed: any = {};
    // Build OpenAI-style messages from Anthropic system + messages
    const msgs: any[] = [];
    if (request.system) {
      const sys = Array.isArray(request.system) ? request.system.map((s: any) => (typeof s === 'string' ? s : '')).join('\n') : String(request.system);
      if (sys && sys.length > 0) { msgs.push({ role: 'system', content: sys }); }
    }
    // Index Anthropic tool schemas by (lowercased) name for argument normalization
    const toolSchemaByName: Map<string, any> = new Map();
    if (Array.isArray((request as any)?.tools)) {
      for (const t of (request as any).tools) {
        if (t && typeof t.name === 'string') {
          toolSchemaByName.set(String(t.name).toLowerCase(), (t as any).input_schema || {});
        }
      }
    }

    for (const m of (request.messages || [])) {
      const role = m.role || 'user';
      const blocks = Array.isArray(m.content)
        ? m.content
        : (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : []);

      // Tool use -> OpenAI tool_calls on assistant message (drop empty/invalid input)
      const toolUses = blocks.filter((b: any) => b && b.type === 'tool_use');
      if (role === 'assistant' && toolUses.length > 0) {
        const tool_calls = toolUses
          .map((t: any) => {
            const raw = t?.input;
            // Parse raw input into object
            let inputObj: any = undefined;
            if (raw !== undefined) {
              if (typeof raw === 'string') {
                try {
                  const parsed = JSON.parse(raw);
                  if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) { inputObj = parsed; }
                } catch { /* ignore */ }
              } else if (typeof raw === 'object' && raw !== null) {
                if (Object.keys(raw).length > 0) { inputObj = raw; }
              }
            }
            // Skip tool calls with empty/invalid input to avoid validation errors
            if (!inputObj) { return undefined; }

            // Normalize according to the matching tool's input_schema (if any)
            const toolName: string = typeof t?.name === 'string' ? t.name : 'tool';
            const schema = toolSchemaByName.get(toolName.toLowerCase());
            const norm = normalizeArgsBySchema(inputObj, schema);
            let finalArgs: any = (norm && norm.value && typeof norm.value === 'object')
              ? norm.value
              : inputObj; // fallback to raw if normalization produced empty

            // Defensive fallback: if no schema and this looks like a search tool, coerce common synonyms
            if (!schema) {
              const lname = toolName.toLowerCase();
              if (lname.includes('search') || lname === 'grep' || lname === 'rg' || lname === 'ripgrep') {
                if (finalArgs && typeof finalArgs === 'object') {
                  if (!('pattern' in finalArgs)) {
                    const q = (finalArgs as any)['query'] ?? (finalArgs as any)['regex'] ?? (finalArgs as any)['_raw'];
                    if (q !== undefined) { finalArgs = { ...finalArgs, pattern: String(q) };
                    }
                  }
                  if (!('glob' in finalArgs) && (finalArgs as any)['include'] !== undefined) {
                    finalArgs = { ...finalArgs, glob: String((finalArgs as any)['include']) };
                  }
                }
              }
            }

            return {
              id: t.id || t.tool_use_id || `call_${Math.random().toString(36).slice(2)}`,
              type: 'function',
              function: { name: toolName, arguments: safeStringify(finalArgs) }
            };
          })
          .filter(Boolean);
        if (tool_calls.length > 0) {
          msgs.push({ role: 'assistant', content: '', tool_calls });
        } else {
          // No valid tool_calls to emit; fall back to any text blocks
          const text = blocks
            .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text)
            .join('\n');
          if (text) { msgs.push({ role: 'assistant', content: text }); }
        }
        continue;
      }

      // Tool result -> OpenAI tool role message
      const toolResults = blocks.filter((b: any) => b && b.type === 'tool_result');
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          const content = typeof tr.content === 'string' ? tr.content : safeStringify(tr.content || {});
          msgs.push({ role: 'tool', content, tool_call_id: tr.tool_use_id || tr.id || '' });
        }
        // Also append any user/assistant text blocks in same message
        const text = blocks
          .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join('\n');
        if (text) { msgs.push({ role, content: text }); }
        continue;
      }

      // Plain user/assistant text-only
      const text = blocks
        .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('\n');
      msgs.push({ role, content: text });
    }
    transformed.messages = msgs;
    if (request.model) {
      transformed.model = request.model;
    } else if ((request as any)?.route?.modelId) {
      transformed.model = (request as any).route.modelId;
    }
    if (this.enableTools && request.tools) { transformed.tools = this.convertAnthropicToolsToOpenAI(request.tools); }
    // tool_choice mapping (Anthropic -> OpenAI)
    if (request.tool_choice) {
      transformed.tool_choice = this.mapAnthropicToolChoiceToOpenAI(request.tool_choice);
    }
    this.copyParameters(request, transformed, requestMappings.parameters);
    return transformed;
  }

  private convertOpenAIRequestToAnthropic(request: any): any {
    const out: any = {};
    // Extract system message from OpenAI messages
    const msgs: any[] = Array.isArray(request?.messages) ? request.messages : [];
    const sysMsg = msgs.find((m: any) => m && m.role === 'system' && typeof m.content === 'string');
    if (sysMsg && typeof sysMsg.content === 'string') {
      out.system = sysMsg.content;
    }
    // Build Anthropic messages
    const contentMsgs: any[] = [];
    const producedToolIds = new Set<string>();

    for (const m of msgs) {
      if (!m || typeof m !== 'object') continue;
      if (m.role === 'system') continue; // moved to out.system
      const role = m.role === 'assistant' ? 'assistant' : (m.role === 'user' ? 'user' : (m.role === 'tool' ? 'user' : m.role));
      const blocks: any[] = [];
      // Assistant tool_calls -> tool_use blocks
      if (m.role === 'assistant') {
        const toolCalls: any[] = Array.isArray((m as any).tool_calls) ? (m as any).tool_calls : [];
        for (const tc of toolCalls) {
          const name = tc?.function?.name || 'tool';
          const rawArgs = tc?.function?.arguments;
          let input: any = undefined;
          if (typeof rawArgs === 'string') {
            try { const parsed = JSON.parse(rawArgs); if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) { input = parsed; } } catch { /* ignore */ }
          } else if (rawArgs && typeof rawArgs === 'object') {
            if (Object.keys(rawArgs).length > 0) { input = rawArgs; }
          }
          // Skip empty/invalid args to avoid tool_use {}
          input = this.normalizeArgsForAnthropic(name, input);
          if (!input) { continue; }
          const toolId = typeof tc?.id === 'string' && tc.id.trim() ? tc.id : `call_${Math.random().toString(36).slice(2,8)}`;
          producedToolIds.add(toolId);
          blocks.push({ type: 'tool_use', id: toolId, name, input });
        }
      }
      // Tool role -> tool_result
      if (m.role === 'tool') {
        const tool_call_id = typeof (m as any).tool_call_id === 'string' ? (m as any).tool_call_id : '';
        const content = typeof m.content === 'string' ? m.content : (typeof m.content === 'object' ? JSON.stringify(m.content) : String(m.content ?? ''));
        if (tool_call_id && producedToolIds.has(tool_call_id)) {
          blocks.push({ type: 'tool_result', tool_use_id: tool_call_id, content });
        } else if (content) {
          blocks.push({ type: 'text', text: content });
        }
      }
      // Text content
      if (typeof m.content === 'string' && m.content.length > 0) {
        blocks.push({ type: 'text', text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part === 'object' && typeof (part as any).text === 'string') {
            blocks.push({ type: 'text', text: (part as any).text });
          }
        }
      }
      contentMsgs.push({ role, content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
    }
    out.messages = contentMsgs;
    if (request.model) { out.model = request.model; }
    if (typeof request.max_tokens === 'number') { out.max_tokens = request.max_tokens; }
    if (typeof request.temperature === 'number') { out.temperature = request.temperature; }
    if (typeof request.top_p === 'number') { out.top_p = request.top_p; }
    // Tools mapping
    // Tools + tool_choice mapping (preserve semantics):
    // - OpenAI 'none' means disable tools => for Anthropic, omit tools entirely
    const oaiToolChoice = request.tool_choice;
    const disableTools = (typeof oaiToolChoice === 'string' && oaiToolChoice === 'none');
    if (this.enableTools && Array.isArray(request.tools) && !disableTools) {
      out.tools = request.tools.map((t: any) => {
        const fn = t?.function || {};
        const name = fn?.name;
        const description = fn?.description;
        let parameters = fn?.parameters;
        if (typeof parameters === 'string') { try { parameters = JSON.parse(parameters); } catch { parameters = {}; } }
        return { name, description, input_schema: parameters || {} };
      });
    }
    if (!disableTools && oaiToolChoice !== undefined) {
      const mapped = this.mapOpenAIToolChoiceToAnthropic(oaiToolChoice);
      if (mapped !== undefined) { out.tool_choice = mapped; }
    }
    // stream passthrough
    if (typeof request.stream === 'boolean') { out.stream = request.stream; }
    return out;
  }

  // Normalize OpenAI arguments to Anthropic tool input schema; return null to drop invalid
  private normalizeArgsForAnthropic(toolName: string, args: any): Record<string, unknown> | null {
    const name = String(toolName || '').toLowerCase();
    const hasKeys = (o: any) => o && typeof o === 'object' && Object.keys(o).length > 0;
    if (!args || typeof args !== 'object') { return null; }

    if (Array.isArray(args)) {
      const objects = args.filter((item) => item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length > 0);
      if (!objects.length) { return null; }
      const merged = objects.reduce((acc: Record<string, unknown>, curr: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(curr)) {
          if (!(key in acc)) {
            acc[key] = value;
          }
        }
        return acc;
      }, {} as Record<string, unknown>);
      args = merged;
    }

    const obj: any = { ...args };
    const take = (o: any, keys: string[]) => {
      const out: any = {};
      for (const k of keys) { if (k in o) out[k] = o[k]; }
      return out;
    };

    if (name === 'bash' || name === 'shell') {
      let command = obj.command;
      if (Array.isArray(command)) { command = command.map((x: any) => String(x)).join(' '); }
      else if (typeof command !== 'string') { command = ''; }
      command = String(command).trim();
      if (!command) { return null; }
      const out: any = { command };
      if (typeof obj.timeout === 'number') out.timeout = obj.timeout;
      if (typeof obj.description === 'string') out.description = obj.description;
      if (typeof obj.run_in_background === 'boolean') out.run_in_background = obj.run_in_background;
      return out;
    }

    if (name === 'read') {
      obj.file_path = obj.file_path || obj.filepath || obj.file || obj.path;
      const out = take(obj, ['file_path','offset','limit']);
      if (!out.file_path || typeof out.file_path !== 'string' || !out.file_path.trim()) { return null; }
      return out;
    }

    if (name === 'write') {
      obj.file_path = obj.file_path || obj.filepath || obj.file || obj.path;
      obj.content = obj.content || obj.text || obj.data;
      const out = take(obj, ['file_path','content']);
      if (!out.file_path || typeof out.file_path !== 'string' || !out.file_path.trim()) { return null; }
      if (!out.content || typeof out.content !== 'string') { return null; }
      return out;
    }

    if (name === 'edit') {
      obj.file_path = obj.file_path || obj.filepath || obj.file || obj.path;
      obj.old_string = obj.old_string || obj.old || obj.from || obj.before;
      obj.new_string = obj.new_string || obj.new || obj.to || obj.after;
      const out = take(obj, ['file_path','old_string','new_string','replace_all']);
      if (!out.file_path || typeof out.file_path !== 'string' || !out.file_path.trim()) { return null; }
      if (!out.old_string || typeof out.old_string !== 'string') { return null; }
      if (!out.new_string || typeof out.new_string !== 'string') { return null; }
      return out;
    }

    if (name === 'glob') {
      obj.pattern = obj.pattern || obj.glob || obj.include;
      // accept array includes
      if (Array.isArray(obj.pattern)) { obj.pattern = obj.pattern.join(','); }
      const out = take(obj, ['pattern']);
      if (!out.pattern || typeof out.pattern !== 'string') { return null; }
      return out;
    }

    if (name === 'grep' || name === 'search') {
      obj.pattern = obj.pattern || obj.query || obj.regex;
      obj.path = obj.path || obj.dir;
      obj.glob = obj.glob || obj.include;
      // accept array includes/globs
      if (Array.isArray(obj.glob)) { obj.glob = obj.glob.join(','); }
      const out = take(obj, ['pattern','path','glob']);
      if (!out.pattern || typeof out.pattern !== 'string') { return null; }
      return out;
    }

    return hasKeys(obj) ? obj : null;
  }

  private convertOpenAIResponseToAnthropic(response: any): any {
    const { responseMappings } = this.conversionConfig;
    const transformed: any = {};
    if (response.choices && response.choices.length > 0) {
      const choice = response.choices[0];
      const message = choice.message || {};
      transformed.role = message.role || 'assistant';
      const blocks: any[] = [];
      if (message.content) {
        if (Array.isArray(message.content)) {
          // If upstream already returns array-like content blocks, map text items
          for (const c of message.content) {
            if (typeof c === 'string') { blocks.push({ type: 'text', text: c }); }
            else if (c && typeof c === 'object' && typeof c.text === 'string') { blocks.push({ type: 'text', text: c.text }); }
          }
        } else if (typeof message.content === 'string') {
          blocks.push({ type: 'text', text: message.content });
        }
      }
      // Some providers (e.g., GLM coding API) return reasoning_content instead of content
      if (typeof (message as any).reasoning_content === 'string' && (message as any).reasoning_content.length > 0) {
        blocks.push({ type: 'text', text: (message as any).reasoning_content });
      }
      if (this.enableTools) {
        // OpenAI multi-tool schema
        if (message.tool_calls) {
          const toolBlocks = this.convertOpenAIToolCallsToAnthropic(message.tool_calls);
          blocks.push(...toolBlocks);
        }
        // Legacy single function_call schema
        if (message.function_call) {
          const fc: any = (message as any).function_call;
          const name = fc?.name || 'tool';
          const rawArgs = fc?.arguments || '';
          let input: any = {};
          try { input = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : (rawArgs || {}); } catch { input = { arguments: rawArgs }; }
          blocks.push({ type: 'tool_use', id: `call_${Math.random().toString(36).slice(2,8)}`, name, input });
        }
      }
      // Ensure content has at least one text block for Anthropic schema compliance
      if (blocks.length === 0) {
        blocks.push({ type: 'text', text: '' });
      }
      transformed.content = blocks;
      // Map finish_reason. If any tool calls present, prefer 'tool_use' to drive client tool flow.
      const hasToolCalls = Array.isArray(blocks) && blocks.some((b: any) => b && b.type === 'tool_use');
      const hasLegacyFn = !!(message as any).function_call;
      if (hasToolCalls || hasLegacyFn) {
        transformed.stop_reason = 'tool_use';
      } else if (choice.finish_reason) {
        transformed.stop_reason = responseMappings.finishReason.mapping[choice.finish_reason] || 'end_turn';
      } else {
        transformed.stop_reason = 'end_turn';
      }
    }
    if (response.usage) {transformed.usage = this.convertUsageStats(response.usage, (responseMappings as any).usage.fieldMapping);}
    if (response.id) {transformed.id = response.id;}
    if (response.model) {transformed.model = response.model;}
    if (response.created) {transformed.created = response.created;}
    return transformed;
  }

  private convertAnthropicToolsToOpenAI(tools: any[]): any[] {
    if (!tools) {return [];}
    return tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }));
  }

  private convertOpenAIToolCallsToAnthropic(toolCalls: any[]): any[] {
    if (!toolCalls) {return [];}
    const out: any[] = [];
    const coerceArgs = (raw: any): any => {
      if (raw === undefined || raw === null) { return {}; }
      if (typeof raw === 'object') { return raw; }
      if (typeof raw !== 'string') { return { _raw: String(raw) }; }
      const s = raw.trim();
      if (!s) { return {}; }
      // Try strict JSON first
      const j = safeParse(s);
      if (j !== undefined) { return j; }
      // Try fenced or substring JSON
      const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      const jsonCandidate = fence ? fence[1] : s;
      const objMatch = jsonCandidate.match(/\{[\s\S]*\}/);
      if (objMatch) { const p = safeParse(objMatch[0]); if (p !== undefined) return p; }
      const arrMatch = jsonCandidate.match(/\[[\s\S]*\]/);
      if (arrMatch) { const p = safeParse(arrMatch[0]); if (p !== undefined) return p; }
      // Try json-ish: single quotes and unquoted keys
      let t = jsonCandidate.replace(/'([^']*)'/g, '"$1"');
      t = t.replace(/([\{,\s])([A-Za-z_][A-Za-z0-9_\-]*)\s*:/g, '$1"$2":');
      const jj = safeParse(t);
      if (jj !== undefined) { return jj; }
      // Try key=value lines
      const obj: Record<string, any> = {};
      const parts = s.split(/[\n,]+/).map(p => p.trim()).filter(Boolean);
      for (const p of parts) {
        const m = p.match(/^([A-Za-z_][A-Za-z0-9_\-]*)\s*[:=]\s*(.+)$/);
        if (!m) continue;
        const key = m[1];
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) { val = val.slice(1, -1); }
        const pv = safeParse(val);
        if (pv !== undefined) { obj[key] = pv; continue; }
        if (/^(true|false)$/i.test(val)) { obj[key] = /^true$/i.test(val); continue; }
        if (/^-?\d+(?:\.\d+)?$/.test(val)) { obj[key] = Number(val); continue; }
        obj[key] = val;
      }
      if (Object.keys(obj).length) { return obj; }
      return { _raw: s };
    };

    for (const call of toolCalls) {
      const rawName = call?.function?.name;
      const argIn = coerceArgs(call?.function?.arguments);
      const id = call?.id || `call_${Math.random().toString(36).slice(2,8)}`;
      const { name, args } = this.normalizeStandardToolCall(rawName, argIn);
      // Drop empty input to avoid invalid parameter errors downstream
      if (!args || (typeof args === 'object' && Object.keys(args).length === 0)) { continue; }
      out.push({ type: 'tool_use', id, name, input: args });
    }
    return out;
  }

  /**
   * Canonicalize common tool names and arguments into the shapes expected by clients.
   * This layer is protocol conversion (OpenAI -> Anthropic), so it's the right place
   * to normalize standard tools independent of provider quirks.
   */
  private normalizeStandardToolCall(rawName: any, rawArgs: any): { name: string; args: Record<string, unknown> } {
    const name0 = typeof rawName === 'string' ? rawName : '';
    const lower = name0.toLowerCase();
    const argsIn = (rawArgs && typeof rawArgs === 'object') ? rawArgs as Record<string, unknown> : {};

    // Helper coercers
    const toStr = (v: any, d = '') => (typeof v === 'string' ? v : (v == null ? d : String(v)));
    const toBool = (v: any, d = false) => (typeof v === 'boolean' ? v : (v == null ? d : String(v).toLowerCase() === 'true'));
    const toInt = (v: any, d = 1) => { const n = Number.parseInt(String(v), 10); return Number.isFinite(n) && n > 0 ? n : d; };

    // Canonicalize common coding-agent tools similar to Claude Code Router
    // apply_patch => ensure argument { input: string }
    if (lower === 'apply_patch' || lower === 'applypatch') {
      let input = '';
      if (typeof (argsIn as any).input === 'string' && (argsIn as any).input.trim()) { input = (argsIn as any).input; }
      else if (typeof (argsIn as any).patch === 'string' && (argsIn as any).patch.trim()) { input = (argsIn as any).patch; }
      else if (typeof (argsIn as any).diff === 'string' && (argsIn as any).diff.trim()) { input = (argsIn as any).diff; }
      else if (typeof (argsIn as any)._raw === 'string' && (argsIn as any)._raw.includes('*** Begin Patch')) { input = (argsIn as any)._raw; }
      else if (Array.isArray((argsIn as any).command) && String((argsIn as any).command[0]) === 'apply_patch') {
        input = String((argsIn as any).command.slice(1).join(' '));
      }
      return { name: 'apply_patch', args: { input } };
    }

    // update_plan => ensure { explanation?: string, plan: [] }
    if (lower === 'update_plan') {
      const plan = Array.isArray((argsIn as any).plan) ? (argsIn as any).plan : [];
      const explanation = typeof (argsIn as any).explanation === 'string' ? (argsIn as any).explanation : '';
      return { name: 'update_plan', args: { explanation, plan } };
    }

    // shell => ensure { command: string[] }
    if (lower === 'shell') {
      const cmd = (argsIn as any).command;
      const tryParseArray = (s: string): string[] | null => { try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String) : null; } catch { return null; } };
      if (typeof cmd === 'string') {
        const parsed = tryParseArray(cmd);
        return { name: 'shell', args: { command: parsed || ['bash','-lc',cmd] } };
      } else if (Array.isArray(cmd)) {
        return { name: 'shell', args: { command: cmd.map(String) } };
      }
      return { name: 'shell', args: { ...(argsIn as any) } };
    }

    // Read: canonical name 'Read', arguments must use { file_path }
    if (['read', 'read_file', 'readfile', 'mcp__read__read', 'mcp__read-file__readfile', 'readfileexact', 'read_file_exact'].includes(lower)) {
      // Handle empty args by inferring common defaults based on context
      if (!argsIn || typeof argsIn !== 'object' || Object.keys(argsIn).length === 0) {
        // For empty Read args, provide common defaults to prevent validation errors
        return { name: 'Read', args: { file_path: 'README.md' } };
      }
      
      const file_path = toStr(
        (argsIn as any)['file_path'] ??
        (argsIn as any)['filepath'] ??
        (argsIn as any)['file'] ??
        (argsIn as any)['path'] ??
        ((Array.isArray((argsIn as any)['paths']) && (argsIn as any)['paths'][0]) ? String((argsIn as any)['paths'][0]) : '') ??
        (argsIn as any)['_raw']
      );
      const offset = (argsIn as any)['offset'];
      const limit = (argsIn as any)['limit'];
      const out: Record<string, unknown> = { file_path };
      if (offset !== undefined) out.offset = offset;
      if (limit !== undefined) out.limit = limit;
      return { name: 'Read', args: out };
    }

    // Search: canonical name 'Search', arguments { pattern, path?, glob? }
    if (['search', 'search_files', 'searchfiles', 'grep', 'mcp__search__search', 'ripgrep', 'rg'].includes(lower)) {
      const pattern = toStr(argsIn['pattern'] ?? (argsIn as any)['query'] ?? (argsIn as any)['regex'] ?? (argsIn as any)['_raw']);
      const basePath = toStr(argsIn['path'] ?? (argsIn as any)['dir'] ?? '');
      const glob = toStr((argsIn as any)['glob'] ?? (argsIn as any)['include'] ?? '');
      const out: Record<string, unknown> = { pattern };
      if (basePath) { out.path = basePath; }
      if (glob) { out.glob = glob; }
      return { name: 'Search', args: out };
    }

    // Glob: canonical name 'Glob', arguments { pattern }
    if (['glob', 'mcp__glob__glob'].includes(lower)) {
      const pattern = toStr((argsIn as any)['pattern'] ?? (argsIn as any)['glob'] ?? (argsIn as any)['_raw']);
      return { name: 'Glob', args: { pattern } };
    }

    // Sequential thinking: canonical name 'sequential-thinking', coerce fields
    if (lower.includes('sequential-thinking') || lower === 'sequentialthinking' || lower === 'mcp__sequential-thinking__sequentialthinking') {
      const thought = toStr(argsIn['thought'] ?? (argsIn as any)['text'] ?? (argsIn as any)['message'] ?? (argsIn as any)['_raw']);
      const nextThoughtNeeded = toBool(argsIn['nextThoughtNeeded'] ?? (argsIn as any)['next_thought_needed'] ?? (argsIn as any)['next'], true);
      const thoughtNumber = toInt(argsIn['thoughtNumber'] ?? (argsIn as any)['thought_number'] ?? 1, 1);
      const totalThoughts = toInt(argsIn['totalThoughts'] ?? (argsIn as any)['total_thoughts'] ?? (argsIn as any)['total'] ?? Math.max(1, Number(thoughtNumber)), 1);
      const mapped: Record<string, unknown> = { thought, nextThoughtNeeded, thoughtNumber, totalThoughts };
      if ('isRevision' in argsIn) { mapped.isRevision = toBool((argsIn as any)['isRevision']); }
      if ('revisesThought' in argsIn) { mapped.revisesThought = toInt((argsIn as any)['revisesThought'], 1); }
      if ('branchFromThought' in argsIn) { mapped.branchFromThought = toInt((argsIn as any)['branchFromThought'], 1); }
      if (typeof (argsIn as any)['branchId'] === 'string') { mapped.branchId = (argsIn as any)['branchId']; }
      if ('needsMoreThoughts' in argsIn) { mapped.needsMoreThoughts = toBool((argsIn as any)['needsMoreThoughts']); }
      return { name: 'sequential-thinking', args: mapped };
    }

    // Default: keep as-is
    return { name: name0, args: argsIn };
  }

  private convertUsageStats(usage: any, fieldMapping: Record<string, string>): any {
    const transformed: any = {};
    for (const [sourceField, targetField] of Object.entries(fieldMapping)) {
      if (usage[sourceField] !== undefined) {transformed[targetField] = usage[sourceField];}
    }
    return transformed;
  }

  private copyParameters(source: any, target: any, parameterMappings: any): void {
    for (const mapping of Object.values(parameterMappings as any)) {
      const src = (mapping as any).source; const dst = (mapping as any).target;
      if (source[src] !== undefined) {target[dst] = source[src];}
    }
  }

  async cleanup(): Promise<void> { this.isInitialized = false; }

  private mapAnthropicToolChoiceToOpenAI(input: any): any {
    if (!input) { return undefined; }
    if (typeof input === 'string') {
      if (input === 'auto' || input === 'none') { return input; }
      return 'auto';
    }
    if (typeof input === 'object' && input !== null) {
      if (input.type === 'tool' && typeof input.name === 'string') {
        return { type: 'function', function: { name: input.name } };
      }
    }
    return undefined;
  }

  private mapOpenAIToolChoiceToAnthropic(input: any): any {
    if (input === undefined || input === null) return undefined;
    if (typeof input === 'string') {
      // Anthropic supports 'auto' and specific tool selection; map unknown/none to 'auto'
      if (input === 'auto') return 'auto';
      if (input === 'none') return 'auto';
      return 'auto';
    }
    if (typeof input === 'object') {
      const t = (input as any);
      if (t.type === 'function' && t.function && typeof t.function.name === 'string') {
        return { type: 'tool', name: t.function.name };
      }
    }
    return undefined;
  }

  /**
   * Build Anthropic SSE-style events from an OpenAI chat.completions response (non-stream).
   * This is used to drive Claude/Anthropic-compatible clients that expect
   * message_start → content_block_(start|delta|stop) → message_stop sequence.
   */
  static toAnthropicEventsFromOpenAI(response: any): Array<{ event: string; data: Record<string, unknown> }> {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    if (!response || typeof response !== 'object') { return events; }
    const id = (response as any).id || `resp_${Date.now()}`;
    const model = (response as any).model || 'unknown';
    const choice = Array.isArray((response as any).choices) ? (response as any).choices[0] : undefined;
    const message = choice?.message || {};
    const usage = (response as any).usage || null;

    // Start message
    events.push({ event: 'message_start', data: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null } } });

    // Tool calls → tool_use blocks
    const toolCalls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const singleFn = (message as any).function_call ? [(message as any).function_call] : [];
    let idx = 0;
    let emittedAnyTool = false;
    const emitToolUse = (name: string, rawArgs: any) => {
      // Only emit tool_use if arguments parse to a non-empty object
      let argsObj: any = undefined;
      if (typeof rawArgs === 'string') {
        try { const parsed = JSON.parse(rawArgs); if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) { argsObj = parsed; } } catch { /* ignore */ }
      } else if (rawArgs && typeof rawArgs === 'object') {
        if (Object.keys(rawArgs).length > 0) { argsObj = rawArgs; }
      }
      if (!argsObj) { return; }

      const toolId = `call_${Math.random().toString(36).slice(2,8)}`;
      events.push({ event: 'content_block_start', data: { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: toolId, name } } });
      const partial = safeStringify(argsObj);
      events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: partial } } });
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: idx } });
      idx++; emittedAnyTool = true;
    };

    for (const tc of toolCalls) {
      const name = tc?.function?.name || 'tool';
      const rawArgs = tc?.function?.arguments;
      emitToolUse(name, rawArgs);
    }
    for (const fc of singleFn) {
      const name = fc?.name || 'tool';
      const rawArgs = (fc as any)?.arguments;
      emitToolUse(name, rawArgs);
    }

    // Assistant text content → text block
    const textContent: string = typeof message.content === 'string' ? message.content : '';
    if (textContent && textContent.length > 0) {
      events.push({ event: 'content_block_start', data: { type: 'content_block_start', index: toolCalls.length, content_block: { type: 'text', text: '' } } });
      events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: toolCalls.length, delta: { type: 'text_delta', text: textContent } } });
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: toolCalls.length } });
    }

    // Message delta (stop reason)
    // Align with Anthropic semantics: if any tool calls exist, emit 'tool_use'.
    const rawStop: string | null = choice?.finish_reason || null;
    const hasAnyTool = emittedAnyTool;
    const mappedStop = hasAnyTool
      ? 'tool_use'
      : (rawStop && (DEFAULT_CONVERSION_CONFIG.responseMappings.finishReason.mapping as Record<string,string>)[rawStop]
        ? (DEFAULT_CONVERSION_CONFIG.responseMappings.finishReason.mapping as Record<string,string>)[rawStop]
        : (rawStop || 'end_turn'));
    events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: mappedStop, stop_sequence: null } } });
    // Message stop
    events.push({ event: 'message_stop', data: { type: 'message_stop', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: mappedStop } } });
    // Optional usage
    if (usage) {
      events.push({ event: 'message_stream_complete', data: { type: 'message_stream_complete', message_id: id, usage } });
    }
    return events;
  }
}

function safeParse(text: any): any | undefined {
  if (text === undefined || text === null) { return undefined; }
  if (typeof text !== 'string') { return text; }
  try { return JSON.parse(text); } catch { return undefined; }
}

function safeStringify(obj: any): string {
  try { return JSON.stringify(obj ?? {}); } catch { return String(obj); }
}
