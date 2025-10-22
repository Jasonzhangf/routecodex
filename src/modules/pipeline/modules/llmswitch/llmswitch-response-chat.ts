import type { LLMSwitchModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../../types/shared-dtos.js';
import type { PipelineDebugLogger } from '../../interfaces/pipeline-interfaces.js';
import { normalizeArgumentsBySchema } from './utils/arguments-normalizer.js';
import { normalizeTools } from './utils/tool-schema-normalizer.js';

type ResponseInputItem = {
  type: string;
  role?: string;
  content?: Array<ResponseContentPart> | null;
  name?: string;
  arguments?: unknown;
  call_id?: string;
  output?: unknown;
};

type ResponseContentPart = {
  type: string;
  text?: string;
};

type ResponseToolDefinition = {
  type: string;
  name?: string;
  description?: string;
  strict?: boolean;
  parameters?: unknown;
};

interface ResponseRequestContext {
  requestId?: string;
  instructions?: string;
  input?: ResponseInputItem[];
  include?: unknown;
  store?: unknown;
  toolChoice?: unknown;
  parallelToolCalls?: boolean;
  metadata?: Record<string, unknown> | undefined;
  responseFormat?: unknown;
  stream?: boolean;
  isChatPayload?: boolean;
  isResponsesPayload?: boolean;
  // Decoupled history snapshot (not sent to provider)
  historyMessages?: Array<{ role: string; content: string }>;
  currentMessage?: { role: string; content: string } | null;
}

export class ResponsesToChatLLMSwitch implements LLMSwitchModule {
  readonly id: string;
  readonly type = 'llmswitch-response-chat';
  readonly protocol = 'openai-responses';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private logger: PipelineDebugLogger;
  private requestContext: Map<string, ResponseRequestContext> = new Map();
  // Runtime validators (built in initialize)
  private chatReqValidator: ((v: unknown) => boolean) | null = null;
  private responsesValidator: ((v: unknown) => boolean) | null = null;

  constructor(config: ModuleConfig, dependencies: ModuleDependencies) {
    this.config = config;
    this.id = `llmswitch-response-chat-${Date.now()}`;
    this.logger = dependencies.logger;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    this.isInitialized = true;
    // Build lightweight AJV validators to sanity-check shapes
    try {
      const AjvMod: any = await import('ajv');
      const ajv = new AjvMod.default({ allErrors: true, strict: false });
      const chatSchema = {
        type: 'object',
        required: ['model', 'messages'],
        additionalProperties: true,
        properties: {
          model: { type: 'string', minLength: 1 },
          stream: { type: 'boolean' },
          messages: {
            type: 'array', minItems: 1,
            items: {
              type: 'object', required: ['role'], additionalProperties: true,
              properties: {
                role: { enum: ['system','user','assistant','tool'] },
                content: { anyOf: [ { type: 'string' }, { type: 'null' }, { type: 'object' }, { type: 'array' } ] },
                tool_calls: { type: 'array' }
              }
            }
          },
          tools: { type: 'array' }
        }
      } as const;
      const responsesSchema = {
        type: 'object', required: ['object','model','output'], additionalProperties: true,
        properties: {
          object: { const: 'response' },
          model: { type: 'string' },
          status: { enum: ['in_progress','completed'] },
          output_text: { type: 'string' },
          output: { type: 'array' },
          required_action: { type: 'object' }
        }
      } as const;
      this.chatReqValidator = ajv.compile(chatSchema);
      this.responsesValidator = ajv.compile(responsesSchema);
    } catch { /* optional */ }
  }

  async processIncoming(requestParam: SharedPipelineRequest | any): Promise<SharedPipelineRequest> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const isDto = requestParam && typeof requestParam === 'object' && 'data' in requestParam && 'route' in requestParam;
    const dto = isDto ? (requestParam as SharedPipelineRequest) : null;
    const payload = isDto ? (dto!.data as Record<string, unknown>) : (requestParam as Record<string, unknown>);

    const context = this.captureRequestContext(payload, dto ?? undefined);
    if (context.requestId) {
      this.requestContext.set(context.requestId, context);
    }

    const normalized = this.buildChatRequest(payload, context);
    const stamped = {
      ...normalized,
      _metadata: {
        ...(normalized._metadata || {}),
        switchType: this.type,
        timestamp: Date.now(),
        entryProtocol: 'responses',
        targetProtocol: 'openai'
      }
    } as Record<string, unknown>;

    this.logger.logTransformation(this.id, 'responses-to-chat-request', payload, stamped);

    if (isDto) {
      return {
        ...dto!,
        data: stamped,
        metadata: {
          ...(dto!.metadata || {}),
          rccResponsesContext: context
        }
      };
    }

    return {
      data: stamped,
      route: {
        providerId: 'unknown',
        modelId: 'unknown',
        requestId: context.requestId || `req_${Date.now()}`,
        timestamp: Date.now()
      },
      metadata: { rccResponsesContext: context },
      debug: { enabled: false, stages: {} }
    } satisfies SharedPipelineRequest;
  }

  async processOutgoing(responseParam: SharedPipelineResponse | any): Promise<SharedPipelineResponse | any> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const isDto = responseParam && typeof responseParam === 'object' && 'data' in responseParam && 'metadata' in responseParam;
    const payload = isDto ? (responseParam as SharedPipelineResponse).data : responseParam;

    const requestId = this.extractRequestId(responseParam);
    const context = requestId ? this.requestContext.get(requestId) : undefined;
    if (requestId && context) {
      this.requestContext.delete(requestId);
    }

    const converted = context && context.isResponsesPayload
      ? this.buildResponsesPayload(payload, context)
      : payload;
    this.logger.logTransformation(this.id, 'chat-to-responses', payload, converted);

    if (isDto) {
      const baseMeta = { ...((responseParam as SharedPipelineResponse).metadata || {}) } as Record<string, unknown>;
      if (context && context.isResponsesPayload) {
        (baseMeta as any).responsesStatus = (converted as any)?.status || 'completed';
      }
      return { ...(responseParam as SharedPipelineResponse), data: converted, metadata: baseMeta as any };
    }

    return converted;
  }

  async transformRequest(request: unknown): Promise<unknown> {
    const dto = await this.processIncoming(request as any);
    return dto.data;
  }

  async transformResponse(response: unknown): Promise<unknown> {
    const converted = this.buildResponsesPayload(response, undefined);
    return converted;
  }

  async cleanup(): Promise<void> {
    this.requestContext.clear();
    this.isInitialized = false;
  }

  async dispose(): Promise<void> {
    await this.cleanup();
  }

  getStats(): Record<string, unknown> {
    return {
      type: this.type,
      initialized: this.isInitialized,
      trackedRequests: this.requestContext.size,
      timestamp: Date.now()
    };
  }

  private captureRequestContext(payload: Record<string, unknown>, dto?: SharedPipelineRequest | undefined): ResponseRequestContext {
    const context: ResponseRequestContext = {
      requestId: dto?.route?.requestId,
      instructions: typeof payload.instructions === 'string' ? (payload.instructions as string) : undefined,
      input: Array.isArray(payload.input) ? (payload.input as ResponseInputItem[]) : undefined,
      include: payload.include,
      store: payload.store,
      toolChoice: payload.tool_choice,
      parallelToolCalls: typeof payload.parallel_tool_calls === 'boolean' ? (payload.parallel_tool_calls as boolean) : undefined,
      metadata: (payload.metadata && typeof payload.metadata === 'object') ? (payload.metadata as Record<string, unknown>) : undefined,
      responseFormat: payload.response_format,
      stream: payload.stream === true,
      isChatPayload: Array.isArray(payload.messages)
    };
    // Capture tools for later arguments normalization (shape-level)
    try {
      if (Array.isArray((payload as any).tools)) {
        (context as any).tools = (payload as any).tools;
      }
    } catch { /* ignore */ }
    context.isResponsesPayload = !context.isChatPayload && Array.isArray(context.input);
    return context;
  }

  private buildChatRequest(payload: Record<string, unknown>, context: ResponseRequestContext): Record<string, unknown> {
    // Normalize tools for schema-aware argument shaping
    const toolsNormalized = Array.isArray(payload.tools) ? this.convertTools(payload.tools as any) : undefined;
    // Build provider-bound messages from full history (+system)
    const combined = this.convertAllInputToMessages(context.instructions, context.input, toolsNormalized as any);

    // Produce a normalized history snapshot from input[] (all message wrappers except the last)
    try {
      const ib = Array.isArray(context.input) ? (context.input as ResponseInputItem[]) : [];
      let lastIdx = -1;
      for (let i = ib.length - 1; i >= 0; i--) {
        const it: any = ib[i];
        if (it && typeof it === 'object' && it.type === 'message') { lastIdx = i; break; }
      }
      const history: Array<{ role: string; content: string }> = [];
      const flattenTextBlocks = (blocks: any[]): string[] => {
        const texts: string[] = [];
        for (const block of blocks || []) {
          if (!block || typeof block !== 'object') { continue; }
          const kind = typeof (block as any).type === 'string' ? String((block as any).type).toLowerCase() : '';
          if ((kind === 'text' || kind === 'input_text' || kind === 'output_text') && typeof (block as any).text === 'string') {
            const t = (block as any).text.trim(); if (t) { texts.push(t); }
            continue;
          }
          if (kind === 'message' && Array.isArray((block as any).content)) {
            texts.push(...flattenTextBlocks((block as any).content));
            continue;
          }
          if (typeof (block as any).content === 'string') {
            const t = (block as any).content.trim(); if (t) { texts.push(t); }
          }
        }
        return texts;
      };
      for (let i = 0; i < ib.length; i++) {
        if (i === lastIdx) { continue; }
        const it: any = ib[i];
        if (it && typeof it === 'object' && it.type === 'message') {
          const role = typeof it.role === 'string' ? it.role : 'user';
          const blocks = Array.isArray(it.content) ? it.content : [];
          const texts = flattenTextBlocks(blocks).join('\n').trim();
          if (texts) { history.push({ role, content: texts }); }
        }
      }
      context.historyMessages = history;
      // Capture current message snapshot (if present)
      try {
        if (lastIdx >= 0) {
          const it: any = ib[lastIdx];
          const role = typeof it?.role === 'string' ? it.role : 'user';
          const blocks = Array.isArray(it?.content) ? it.content : [];
          const text = flattenTextBlocks(blocks).join('\n').trim();
          context.currentMessage = text ? { role, content: text } : null;
        } else { context.currentMessage = null; }
      } catch { context.currentMessage = null; }
    } catch { /* ignore history snapshot errors */ }

    const result: Record<string, unknown> = {
      model: payload.model,
      messages: combined
    };
    // Preserve internal override key if carried from protocol layer

    if (payload.temperature !== undefined) {
      result.temperature = payload.temperature;
    }
    if (payload.top_p !== undefined) {
      result.top_p = payload.top_p;
    }
    // Map Responses limits to Chat max_tokens with conservative clamping for GLM models to avoid 1210 errors
    const modelStr = typeof payload.model === 'string' ? (payload.model as string) : '';
    const isGLM = /\bglm\b|zhipu|bigmodel/i.test(modelStr);
    const pickMax = (val: unknown): number | undefined => {
      if (typeof val === 'number' && isFinite(val)) {
        const n = Math.max(1, Math.floor(val));
        return isGLM ? Math.min(n, 8192) : n;
      }
      return undefined;
    };
    const mo = pickMax((payload as any).max_output_tokens);
    const mt = pickMax((payload as any).max_tokens);
    if (typeof mo === 'number') { result.max_tokens = mo; }
    if (typeof mt === 'number') { result.max_tokens = mt; }
    if (payload.frequency_penalty !== undefined) {
      result.frequency_penalty = payload.frequency_penalty;
    }
    if (payload.presence_penalty !== undefined) {
      result.presence_penalty = payload.presence_penalty;
    }
    if (payload.response_format !== undefined) {
      result.response_format = payload.response_format;
    }
    if (Array.isArray(payload.tools)) {
      result.tools = toolsNormalized;
    }
    // If current request contains any tool results, avoid forcing tool_choice (prevents re-trigger loops)
    const hasToolResult = Array.isArray(context.input)
      && (context.input as any[]).some((it: any) => it && typeof it === 'object' && ['function_call_output','tool_result','tool_message'].includes(String(it.type || '').toLowerCase()));
    if (!hasToolResult && payload.tool_choice !== undefined) {
      result.tool_choice = payload.tool_choice;
    }
    if (payload.parallel_tool_calls !== undefined) {
      result.parallel_tool_calls = payload.parallel_tool_calls;
    }
    if (payload.user !== undefined) {
      result.user = payload.user;
    }
    if (payload.logit_bias !== undefined) {
      result.logit_bias = payload.logit_bias;
    }
    if (payload.seed !== undefined) {
      result.seed = payload.seed;
    }
    if (payload.stream !== undefined) {
      result.stream = payload.stream;
    }

    // Validate Chat request (best-effort)
    try {
      if (this.chatReqValidator && !this.chatReqValidator(result)) {
        throw new Error('Responses→Chat produced invalid Chat request');
      }
    } catch { /* soft */ }
    return result;
  }

  // Map full Responses input[] history into OpenAI Chat messages (preserve tool calls and tool outputs)
  private convertAllInputToMessages(instructions?: string, input?: ResponseInputItem[], toolsNormalized?: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];

    const pushText = (role: string, value: string | string[] | undefined | null) => {
      if (value == null) return;
      if (Array.isArray(value)) {
        const filtered = value.map(v => v.trim()).filter(Boolean);
        if (filtered.length) messages.push({ role, content: filtered.map(text => ({ type: 'text', text })) });
        return;
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) messages.push({ role, content: trimmed });
      }
    };

    // Track last function_call id for associating subsequent tool outputs when explicit id is missing
    let lastFunctionCallId: string | null = null;
    const toolNameById: Record<string, string> = {};

    const normalizeShellArgsObject = (obj: any): any => {
      try {
        if (!obj || typeof obj !== 'object') return obj;
        if (!('command' in obj)) return obj;
        const v = (obj as any).command;
        const splitShell = (s: string): string[] => {
          const out: string[] = [];
          let cur = '';
          let quote: null | 'single' | 'double' = null;
          let esc = false;
          for (const ch of String(s)) {
            if (esc) { cur += ch; esc = false; continue; }
            if (ch === '\\') { esc = true; continue; }
            if (quote === 'single') { if (ch === '\'') { quote = null; } else { cur += ch; } continue; }
            if (quote === 'double') { if (ch === '"') { quote = null; } else { cur += ch; } continue; }
            if (ch === '\'') { quote = 'single'; continue; }
            if (ch === '"') { quote = 'double'; continue; }
            if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
            cur += ch;
          }
          if (cur) out.push(cur);
          return out.filter(Boolean);
        };
        if (typeof v === 'string') {
          (obj as any).command = splitShell(v);
          return obj;
        }
        if (Array.isArray(v) && v.length === 1 && typeof v[0] === 'string' && v[0].includes(' ')) {
          (obj as any).command = splitShell(v[0]);
          return obj;
        }
        return obj;
      } catch { return obj; }
    };

    const isJsonish = (s: string): boolean => /^\s*[\[{]/.test(s || '');
    const formatJsonOutputStrict = (raw: string): string => {
      const val = JSON.parse(String(raw));
      const pickFromObject = (o: any): string => {
        if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('tool_result JSON must be object');
        if (typeof o.text === 'string') return o.text;
        if (typeof o.content === 'string') return o.content;
        if (typeof o.output === 'string') return o.output;
        const listKeys = ['resources','items','results','files','lines'];
        for (const k of listKeys) {
          if (Array.isArray((o as any)[k])) {
            const arr = (o as any)[k] as any[];
            if (arr.length === 0) return `${k}: 0`;
            const lines = arr.map((it) => {
              if (typeof it === 'string') return it;
              if (it && typeof it === 'object') {
                if (typeof (it as any).uri === 'string') return String((it as any).uri);
                if (typeof (it as any).path === 'string') return String((it as any).path);
                if (typeof (it as any).name === 'string') return String((it as any).name);
                if (typeof (it as any).id === 'string') return String((it as any).id);
                if (typeof (it as any).text === 'string') return String((it as any).text);
                if (typeof (it as any).content === 'string') return String((it as any).content);
              }
              throw new Error('tool_result item has unsupported structure');
            });
            return lines.join('\n');
          }
        }
        throw new Error('tool_result object has no supported keys');
      };
      if (Array.isArray(val)) {
        if (val.length === 0) return '[]';
        const lines = val.map((it) => {
          if (typeof it === 'string') return it;
          if (it && typeof it === 'object') return pickFromObject(it);
          throw new Error('tool_result array contains unsupported element');
        });
        return lines.join('\n');
      }
      if (typeof val === 'object') return pickFromObject(val);
      throw new Error('tool_result JSON must be object or array');
    };

    const pushAssistantToolCall = (name: string | undefined, args: unknown, callId?: string) => {
      const fnName = (typeof name === 'string' && name.trim()) ? name.trim() : 'tool';
      const serialized = this.serializeArgsStrict(args, fnName, toolsNormalized).trim();
      const toolId = callId || `call_${Math.random().toString(36).slice(2, 6)}`;
      lastFunctionCallId = toolId;
      const tc = { id: toolId, type: 'function', function: { name: fnName, arguments: serialized } } as Record<string, unknown>;
      toolNameById[toolId] = fnName;
      messages.push({ role: 'assistant', tool_calls: [tc] });
    };

    const flattenTextBlocks = (blocks: any[]): string[] => {
      const texts: string[] = [];
      for (const block of blocks || []) {
        if (!block || typeof block !== 'object') continue;
        const kind = typeof (block as any).type === 'string' ? String((block as any).type).toLowerCase() : '';
        if ((kind === 'text' || kind === 'input_text' || kind === 'output_text') && typeof (block as any).text === 'string') {
          const t = (block as any).text.trim(); if (t) texts.push(t);
          continue;
        }
        if (kind === 'message' && Array.isArray((block as any).content)) {
          texts.push(...flattenTextBlocks((block as any).content));
          continue;
        }
        if (typeof (block as any).content === 'string') {
          const t = (block as any).content.trim(); if (t) texts.push(t);
        }
      }
      return texts;
    };

    const coerceObject = (val: unknown): unknown => {
      if (val === null || val === undefined) return {};
      if (typeof val === 'object') return val;
      if (typeof val === 'string') {
        const s = val.trim();
        if (!s) return {};
        try { const p = JSON.parse(s); if (p && typeof p === 'object') return p; } catch { /* ignore */ }
        return { _raw: s };
      }
      return { _raw: String(val) };
    };

    // 1) system instructions
    if (instructions && instructions.trim().length) {
      pushText('system', instructions.trim());
    }

    // 2) full input history
    if (Array.isArray(input)) {
      for (const it of input) {
        if (!it || typeof it !== 'object') continue;
        const itType = String((it as any).type || '').toLowerCase();

        // Top-level assistant tool calls
        if (itType === 'function_call' || itType === 'tool_call') {
          const name = (it as any).name || (it as any)?.function?.name;
          const args = (it as any).arguments ?? (it as any)?.function?.arguments ?? {};
          const id = (it as any).id || (it as any).call_id;
          // Reuse unified helper which applies schema-aware normalization and double-JSON parsing
          pushAssistantToolCall(typeof name === 'string' ? name : undefined, args, typeof id === 'string' ? id : undefined);
          continue;
        }

        // Top-level tool results
        if (itType === 'function_call_output' || itType === 'tool_result' || itType === 'tool_message') {
          // Follow Anthropic->OpenAI: prefer string content; otherwise JSON-stringify structured content
          let outContent = '';
          if (typeof (it as any).text === 'string') {
            const s = (it as any).text.trim(); if (s) outContent = s;
          } else if (typeof (it as any).content === 'string') {
            const s = (it as any).content.trim(); if (s) outContent = s;
          } else if (Array.isArray((it as any).content)) {
            try { outContent = JSON.stringify((it as any).content); } catch { /* ignore */ }
          } else if ((it as any).output !== undefined) {
            const out = (it as any).output;
            if (typeof out === 'string') { const s = out.trim(); if (s) outContent = s; }
            else if (out && typeof out === 'object') { try { outContent = JSON.stringify(out); } catch { /* ignore */ } }
          }
          if (outContent) {
            const explicitId = (typeof (it as any).id === 'string' ? (it as any).id
              : (typeof (it as any).call_id === 'string' ? (it as any).call_id
                : (typeof (it as any).tool_call_id === 'string' ? (it as any).tool_call_id
                  : (typeof (it as any).tool_use_id === 'string' ? (it as any).tool_use_id : undefined))));
            const tool_call_id = explicitId || lastFunctionCallId || undefined;
            const toolMsg: Record<string, unknown> = tool_call_id ? { role: 'tool', content: outContent, tool_call_id } : { role: 'tool', content: outContent };
            messages.push(toolMsg);
          }
          continue;
        }

        // Nested message with blocks
        if ((it as any).type !== 'message') continue;
        const role = typeof (it as any).role === 'string' ? (it as any).role : 'user';
        const blocks = Array.isArray((it as any).content) ? ((it as any).content as any[]) : [];

        const localToolCalls: Array<Record<string, unknown>> = [];
        const localToolMsgs: Array<Record<string, unknown>> = [];

        for (const b of blocks) {
          if (!b || typeof b !== 'object') continue;
          const t = String((b as any).type || '').toLowerCase();
          if (t === 'function_call' || t === 'tool_call') {
            const name = (b as any).name || (b as any)?.function?.name;
            let args = (b as any).arguments ?? (b as any)?.function?.arguments ?? {};
            try { if (typeof args === 'string') args = JSON.parse(args); } catch { /* keep string */ }
            const id = (b as any).id || (b as any).call_id;
            const fnName = typeof name === 'string' && name.trim() ? name.trim() : 'tool';
            const serialized = this.serializeArgsStrict(args, fnName, toolsNormalized).trim();
            const toolId = typeof id === 'string' ? id : `call_${Math.random().toString(36).slice(2, 6)}`;
            lastFunctionCallId = toolId;
            toolNameById[toolId] = fnName;
            localToolCalls.push({ id: toolId, type: 'function', function: { name: fnName, arguments: serialized } });
            continue;
          }
          if (t === 'function_call_output' || t === 'tool_result' || t === 'tool_message') {
            // Follow Anthropic->OpenAI practice
            let outContent = '';
            if (typeof (b as any).text === 'string') {
              const s = (b as any).text.trim(); if (s) outContent = s;
            } else if (typeof (b as any).content === 'string') {
              const s = (b as any).content.trim(); if (s) outContent = s;
            } else if (Array.isArray((b as any).content)) {
              try { outContent = JSON.stringify((b as any).content); } catch { /* ignore */ }
            } else if ((b as any).output !== undefined) {
              const out = (b as any).output;
              if (typeof out === 'string') { const s = out.trim(); if (s) outContent = s; }
              else if (out && typeof out === 'object') { try { outContent = JSON.stringify(out); } catch { /* ignore */ } }
            }
            if (outContent) {
              const explicitId = (typeof (b as any).id === 'string' ? (b as any).id
                : (typeof (b as any).call_id === 'string' ? (b as any).call_id
                  : (typeof (b as any).tool_call_id === 'string' ? (b as any).tool_call_id
                    : (typeof (b as any).tool_use_id === 'string' ? (b as any).tool_use_id : undefined))));
              const tool_call_id = explicitId || lastFunctionCallId || undefined;
              const toolMsg: Record<string, unknown> = tool_call_id ? { role: 'tool', content: outContent, tool_call_id } : { role: 'tool', content: outContent };
              localToolMsgs.push(toolMsg);
            }
            continue;
          }
        }

        if (localToolCalls.length > 0) {
          messages.push({ role: 'assistant', content: '', tool_calls: localToolCalls });
        }
        if (localToolMsgs.length > 0) {
          for (const tm of localToolMsgs) messages.push(tm);
        }
        const texts = flattenTextBlocks(blocks);
        if (texts.length) pushText(role, texts.join('\n'));
      }
    }

    return messages;
  }

  private convertInputToMessages(instructions?: string, input?: ResponseInputItem[], toolsNormalized?: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];

    const pushText = (role: string, value: string | string[] | undefined | null) => {
      if (value == null) {
        return;
      }
      if (Array.isArray(value)) {
        const filtered = value.map(v => v.trim()).filter(Boolean);
        if (filtered.length) {
          messages.push({ role, content: filtered.map(text => ({ type: 'text', text })) });
        }
        return;
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) {
          messages.push({ role, content: trimmed });
        }
      }
    };

    const pushToolCall = (name: string, args: unknown, callId?: string) => {
      const serialized = this.serializeArgsStrict(args, name, toolsNormalized).trim();
      // Omit empty content to avoid blank assistant messages
      messages.push({
        role: 'assistant',
        tool_calls: [{ id: callId || `call_${Math.random().toString(36).slice(2, 6)}`, type: 'function', function: { name, arguments: serialized } }]
      });
    };

    const flattenTextBlocks = (blocks: any[]): string[] => {
      const texts: string[] = [];
      for (const block of blocks) {
        if (!block || typeof block !== 'object') { continue; }
        const kind = typeof block.type === 'string' ? block.type.toLowerCase() : '';
        if ((kind === 'text' || kind === 'input_text' || kind === 'output_text') && typeof block.text === 'string') {
          const trimmed = block.text.trim();
          if (trimmed) { texts.push(trimmed); }
          continue;
        }
        if (kind === 'message' && Array.isArray(block.content)) {
          texts.push(...flattenTextBlocks(block.content));
          continue;
        }
        if (typeof block.content === 'string') {
          const trimmed = block.content.trim();
          if (trimmed) { texts.push(trimmed); }
        }
      }
      return texts;
    };

    const coerceToolInput = (value: unknown): unknown => {
      if (value === null || value === undefined) { return {}; }
      if (typeof value === 'object' && !Array.isArray(value)) { return value; }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) { return {}; }
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object') { return parsed; }
        } catch { /* ignore */ }
        return { _raw: trimmed };
      }
      if (Array.isArray(value)) {
        const objects = value.filter(v => v && typeof v === 'object' && !Array.isArray(v));
        if (objects.length) {
          return objects.reduce((acc: any, cur: any) => {
            for (const [k, v] of Object.entries(cur)) {
              if (!(k in acc)) { acc[k] = v; }
            }
            return acc;
          }, {} as Record<string, unknown>);
        }
        const primitives = value
          .map(v => v == null ? '' : String(v))
          .filter(v => v.trim().length);
        if (primitives.length) { return { _raw: primitives.join(' ') }; }
        return {};
      }
      return { _raw: String(value) };
    };

    if (instructions && instructions.trim().length) {
      pushText('system', instructions.trim());
    }

    // Only use current-turn content: pick the last 'message' item in input as the user turn.
    // Do not replay historical messages or prior assistant/tool events to provider.
    let lastMsg: any | null = null;
    if (Array.isArray(input)) {
      for (let i = input.length - 1; i >= 0; i--) {
        const it = input[i];
        if (it && typeof it === 'object' && (it as any).type === 'message') { lastMsg = it; break; }
      }
    }

    if (lastMsg) {
      const role = typeof (lastMsg as any).role === 'string' ? (lastMsg as any).role : 'user';
      const blocks = Array.isArray((lastMsg as any).content) ? (lastMsg as any).content : [];
      const texts = flattenTextBlocks(blocks);
      if (texts.length) { pushText(role, texts.join('\n')); }
    } else if (Array.isArray(input)) {
      // Fallback: if no explicit message wrapper, attempt to flatten entire tail as a single user prompt
      const texts = flattenTextBlocks(input as any);
      if (texts.length) { pushText('user', texts.join('\n')); }
    }

    return messages;
  }
  private convertContentPartsToChat(content?: Array<ResponseContentPart> | null): string | Array<Record<string, unknown>> {
    if (!content || !Array.isArray(content) || content.length === 0) {
      return '';
    }

    const allText = content.every(part => typeof part?.text === 'string');
    if (allText) {
      const merged = content
        .map(part => (typeof part?.text === 'string' ? part.text.trim() : ''))
        .filter(part => part.length > 0);
      return merged.length ? merged.join('\n') : '';
    }

    const mapped = content
      .map(part => {
        const text = typeof part?.text === 'string' ? part.text.trim() : '';
        if (!text) {
          return null;
        }
        return { type: 'text', text };
      })
      .filter((part): part is { type: string; text: string } => part !== null);

    if (!mapped.length) {
      return '';
    }

    return mapped;
  }

  private convertTools(tools: ResponseToolDefinition[]): Array<Record<string, unknown>> {
    // Normalize tools using shared normalizer (shape-level, provider-agnostic)
    return normalizeTools(tools) as Array<Record<string, unknown>>;
  }

  private buildResponsesPayload(payload: unknown, context?: ResponseRequestContext): Record<string, unknown> | unknown {
    if (!payload || typeof payload !== 'object') {
      return payload;
    }

    const response = this.unwrapData(payload as Record<string, unknown>);
    if (!response || typeof response !== 'object') {
      return payload;
    }

    const respObjectType = (response as any).object;
    if (respObjectType === 'response' && Array.isArray((response as any).output)) {
      return response;
    }

    const choices = Array.isArray((response as any).choices) ? (response as any).choices : [];
    const primaryChoice = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : undefined;
    const message = primaryChoice && typeof primaryChoice.message === 'object' ? primaryChoice.message as Record<string, unknown> : undefined;
    const role = message?.role || 'assistant';
    const content = message?.content;
    // GLM/others may return private reasoning text under reasoning_content; persist it into Responses payload
    const reasoningText = typeof (message as any)?.reasoning_content === 'string' && ((message as any).reasoning_content as string).trim().length
      ? String((message as any).reasoning_content).trim()
      : undefined;

    const outputItems: Array<Record<string, unknown>> = [];
    if (reasoningText) {
      outputItems.push({
        type: 'reasoning',
        summary: [],
        content: [ { type: 'output_text', text: reasoningText } ]
      });
    }
    const convertedContent = this.convertChatContentToResponses(content);
    if (convertedContent.length > 0) {
      outputItems.push({
        type: 'message',
        message: {
          role,
          content: convertedContent
        }
      });
    }

    const toolCalls = Array.isArray(message?.tool_calls) ? (message!.tool_calls as Array<Record<string, unknown>>) : [];
    if (toolCalls.length > 0) {
      // normalize arguments by schema (shape-level)
      const toolsNorm = normalizeTools(((context as any)?.tools || (context as any)?.metadata?.tools || []));
      for (const call of toolCalls) {
        const toolId = typeof call.id === 'string' ? call.id : `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const fn = (call && typeof call.function === 'object') ? (call.function as Record<string, unknown>) : undefined;
        const fnName = typeof fn?.name === 'string' ? (fn.name as string) : undefined;
        const rawArgs = fn?.arguments;
        const serializedArgsRaw = typeof rawArgs === 'string' ? rawArgs : (rawArgs && typeof rawArgs === 'object' ? JSON.stringify(rawArgs) : '');
        const serializedArgs = normalizeArgumentsBySchema(serializedArgsRaw, fnName, toolsNorm);

        outputItems.push({
          type: 'function_call',
          id: toolId,
          call_id: toolId,
          name: fnName,
          arguments: serializedArgs,
          status: 'in_progress'
        });
      }
    }

    const usage = (response as any).usage;
    const outputText = this.extractOutputText(convertedContent, toolCalls);

    const finishReason = (Array.isArray((response as any)?.choices) && (response as any).choices[0]?.finish_reason) || undefined;
    const hasToolCalls = toolCalls.length > 0;
    const status = hasToolCalls && !outputText ? 'in_progress' : 'completed';

    const out: any = {
      id: (response as any).id || `resp-${Date.now()}`,
      object: 'response',
      created_at: (response as any).created_at || (response as any).created || Math.floor(Date.now() / 1000),
      model: (response as any).model,
      status,
      output: outputItems,
      output_text: outputText || '',
      ...(usage ? { usage } : {}),
      metadata: context?.metadata,
      instructions: context?.instructions,
      parallel_tool_calls: context?.parallelToolCalls,
      tool_choice: context?.toolChoice,
      include: context?.include,
      store: context?.store
    };
    // Do not emit required_action in Responses payload; handled by client flows
    // Validate Responses payload (best-effort)
    try {
      if (this.responsesValidator && !this.responsesValidator(out)) {
        throw new Error('Chat→Responses produced invalid Responses payload');
      }
    } catch { /* soft */ }
    return out;
  }

  private unwrapData(value: Record<string, unknown>): Record<string, unknown> {
    let current: any = value;
    const seen = new Set<any>();
    while (current && typeof current === 'object' && !Array.isArray(current) && !seen.has(current)) {
      seen.add(current);
      if ('choices' in current || 'message' in current) {
        break;
      }
      if ('data' in current && typeof current.data === 'object') {
        current = current.data;
        continue;
      }
      break;
    }
    return current as Record<string, unknown>;
  }

  private convertChatContentToResponses(content: unknown): Array<Record<string, unknown>> {
    if (!content) {
      return [];
    }
    if (typeof content === 'string') {
      return [{ type: 'output_text', text: content }];
    }
    if (Array.isArray(content)) {
      return (content as Array<any>).map((part) => {
        if (typeof part === 'string') {
          return { type: 'output_text', text: part };
        }
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') {
            return { type: 'output_text', text: part.text };
          }
          return { type: part.type || 'output_text', text: part.text ?? '' };
        }
        return { type: 'output_text', text: String(part) };
      });
    }
    if (typeof content === 'object') {
      try {
        return [{ type: 'output_text', text: JSON.stringify(content) }];
      } catch {
        return [{ type: 'output_text', text: String(content) }];
      }
    }
    return [{ type: 'output_text', text: String(content) }];
  }

  private extractOutputText(parts: Array<Record<string, unknown>>, toolCalls: Array<Record<string, unknown>>): string {
    if (parts.length > 0) {
      const text = parts
        .filter(part => typeof part.text === 'string')
        .map(part => part.text as string)
        .join('\n')
        .trim();
      if (text.length) {
        return text;
      }
    }
    // When only tool calls are present, keep output_text empty; do not serialize tool calls into text
    return '';
  }

  private stringifyMaybeJson(value: unknown): string {
    // Deprecated: no fallback stringify in strict mode
    throw new Error('stringifyMaybeJson is not allowed in strict mode');
  }

  private serializeArgsStrict(raw: unknown, fnName?: string, toolsNormalized?: Array<Record<string, unknown>>): string {
    if (raw === null || raw === undefined) throw new Error('tool_call.arguments missing');
    const normalizeBySchema = (obj: any): any => {
      try {
        if (!fnName || !Array.isArray(toolsNormalized)) return obj;
        const entry = (toolsNormalized as any[]).find(t => t && typeof t === 'object' && t.function && t.function.name === fnName);
        const params = entry?.function?.parameters;
        const cmdDef = params?.properties?.command;
        if (!cmdDef) return obj;
        // If schema expects array<string> but we have string → split? We do not split heuristically. Enforce types; otherwise throw.
        if (cmdDef.type === 'array' && cmdDef.items && cmdDef.items.type === 'string') {
          if (Array.isArray(obj.command)) return obj;
          if (typeof obj.command === 'string') throw new Error('command must be array<string> per schema');
          return obj;
        }
        if (cmdDef.type === 'string') {
          if (Array.isArray(obj.command)) {
            // Join deterministically with spaces; quoting is assumed preserved in tokens
            obj.command = obj.command.join(' ');
          } else if (typeof obj.command !== 'string') {
            obj.command = String(obj.command ?? '');
          }
          return obj;
        }
        return obj;
      } catch { return obj; }
    };

    if (typeof raw === 'string') {
      const s = raw.trim();
      const obj = JSON.parse(s);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('tool_call.arguments must be JSON object');
      const shaped = normalizeBySchema(obj);
      return JSON.stringify(shaped);
    }
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      const shaped = normalizeBySchema(raw as any);
      return JSON.stringify(shaped);
    }
    throw new Error('tool_call.arguments must be object or JSON string');
  }

  private extractRequestId(response: SharedPipelineResponse | any): string | undefined {
    if (response && typeof response === 'object') {
      if ('metadata' in response && response.metadata && typeof response.metadata === 'object') {
        const meta = response.metadata as Record<string, unknown>;
        if (typeof meta.requestId === 'string') {
          return meta.requestId;
        }
      }
    }
    return undefined;
  }
}
