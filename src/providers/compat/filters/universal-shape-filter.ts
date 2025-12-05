import * as fs from 'fs/promises';
import * as path from 'path';
import type { UnknownObject } from '../../../modules/pipeline/types/common-types.js';
import type { CompatibilityContext } from '../compatibility-interface.js';

type FilterConfig = {
  request: {
    allowTopLevel: string[];
    messages: {
      allowedRoles: string[];
      assistantWithToolCallsContentNull?: boolean;
      toolContentStringify?: boolean;
      // Deprecated in favor of messagesRules; kept for back-compat
      suppressAssistantToolCalls?: boolean;
      // (no request interception; do not drop error echos here)
    };
    tools?: {
      normalize?: boolean;
      forceToolChoiceAuto?: boolean;
    };
    assistantToolCalls?: {
      functionArgumentsType?: 'object' | 'string';
    };
    // New: generic, config-driven message rules (field-level)
    // Example (GLM): [{ when: { role:'assistant', hasToolCalls: true }, action:'drop' }]
    messagesRules?: Array<{
      when?: { role?: 'system' | 'user' | 'assistant' | 'tool'; hasToolCalls?: boolean };
      action: 'drop' | 'keep' | 'set';
      set?: Record<string, unknown>;
    }>;
  };
  response: {
    allowTopLevel: string[];
    choices: {
      required?: boolean;
      message: {
        allow: string[];
        roleDefault?: string;
        contentNullWhenToolCalls?: boolean;
        tool_calls?: {
          function?: {
            nameRequired?: boolean;
            argumentsType?: 'object' | 'string';
          };
        };
      };
      finish_reason?: string[];
    };
    usage?: { allow: string[] };
  };
};

type RequestConfig = FilterConfig['request'];
type ResponseConfig = FilterConfig['response'];

const DEFAULT_TOOL_OUTPUT = 'Command succeeded (no output).';

function isRecord(value: unknown): value is UnknownObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toRecord(value: unknown): UnknownObject {
  return isRecord(value) ? value : {};
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function hasArrayItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

export class UniversalShapeFilter {
  private cfg: FilterConfig | null = null;
  private readonly configPath?: string;
  private readonly inlineConfig?: FilterConfig;

  constructor(options: { configPath?: string; config?: FilterConfig } = {}) {
    this.configPath = options.configPath;
    this.inlineConfig = options.config;
  }

  async initialize(): Promise<void> {
    if (this.inlineConfig) { this.cfg = this.inlineConfig; return; }
    const file = this.configPath ? (path.isAbsolute(this.configPath) ? this.configPath : path.join(process.cwd(), this.configPath)) : '';
    if (file) {
      try {
        const text = await fs.readFile(file, 'utf-8');
        this.cfg = JSON.parse(text) as FilterConfig;
        return;
      } catch { /* fallthrough to default */ }
    }
    this.cfg = {
      request: {
        allowTopLevel: ['model','messages','stream','thinking','do_sample','temperature','top_p','max_tokens','tool_stream','tools','tool_choice','stop','response_format','request_id','user_id'],
        messages: { allowedRoles: ['system','user','assistant','tool'], assistantWithToolCallsContentNull: true, toolContentStringify: true },
        tools: { normalize: true, forceToolChoiceAuto: true },
        assistantToolCalls: { functionArgumentsType: 'string' }  // 修复：默认使用string格式而不是object
      },
      response: {
        // 保留 Responses 协议关键字段，避免在合成/转换前被丢弃
        allowTopLevel: [
          'id','request_id','created','model',
          'choices','usage','video_result','web_search','content_filter',
          // Responses 专有/常见：
          'required_action','output','output_text','status'
        ],
        choices: {
          required: true,
          message: {
            allow: ['role','content','reasoning_content','audio','tool_calls'],
            roleDefault: 'assistant',
            contentNullWhenToolCalls: true,
            tool_calls: { function: { nameRequired: true, argumentsType: 'string' } }
          },
          finish_reason: ['stop','tool_calls','length','sensitive','network_error']
        },
        usage: { allow: ['prompt_tokens','completion_tokens','prompt_tokens_details','total_tokens'] }
      }
    } as FilterConfig;
  }

  private shallowPick(obj: unknown, allow: string[]): UnknownObject {
    if (!isRecord(obj)) {
      return {};
    }
    const out: UnknownObject = {};
    for (const key of allow) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        out[key] = obj[key];
      }
    }
    return out;
  }

  private toObjectArgs(value: unknown): UnknownObject {
    if (value === null || value === undefined) {
      return {};
    }
    if (isRecord(value)) {
      return value;
    }
    if (typeof value === 'string') {
      try { return JSON.parse(value) as UnknownObject; }
      catch { return { raw: value }; }
    }
    return {};
  }

  private toStringArgs(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }
    try { return JSON.stringify(value ?? {}); }
    catch { return '{}'; }
  }

  private normalizeToolContent(value: unknown): string {
    if (typeof value === 'string') {
      return value.trim().length ? value : DEFAULT_TOOL_OUTPUT;
    }
    if (value === null || value === undefined) {
      return DEFAULT_TOOL_OUTPUT;
    }
    try {
      const text = JSON.stringify(value);
      return text && text.length ? text : DEFAULT_TOOL_OUTPUT;
    } catch {
      return DEFAULT_TOOL_OUTPUT;
    }
  }

  async applyRequestFilter(payload: UnknownObject): Promise<UnknownObject> {
    const cfg = this.cfg!;

    const allow = new Set(cfg.request.allowTopLevel);
    const src = toRecord(payload);
    const out: UnknownObject = {};
    for (const key of Object.keys(src)) {
      if (allow.has(key)) {
        out[key] = src[key];
      }
    }

    const normalizedMessages = this.normalizeRequestMessages(out.messages, cfg.request);
    out.messages = normalizedMessages;

    this.normalizeTools(out, cfg.request);
    this.cleanupToolChoice(out);

    return out;
  }

  async applyResponseFilter(payload: UnknownObject, _ctx?: CompatibilityContext): Promise<UnknownObject> {
    // Bypass shape filtering by default to keep system running; can be turned off via env.
    // Default: RCC_COMPAT_FILTER_OFF_RESPONSES is treated as ON unless explicitly set to 0/false/off.
    const envFlag = String(process.env.RCC_COMPAT_FILTER_OFF_RESPONSES || '1').toLowerCase();
    const envBypass = !(envFlag === '0' || envFlag === 'false' || envFlag === 'off');
    try {
      const ctx = _ctx as (CompatibilityContext & { endpoint?: string }) | undefined;
      const entryEndpoint = typeof ctx?.entryEndpoint === 'string' ? ctx.entryEndpoint : undefined;
      const fallbackEndpoint = typeof ctx?.endpoint === 'string' ? ctx.endpoint : undefined;
      const entry = String(entryEndpoint ?? fallbackEndpoint ?? '').toLowerCase();
      if (entry === '/v1/responses' || envBypass) {
        return payload;
      }
    } catch {
      if (envBypass) {
        return payload;
      }
    }
    const cfg = this.cfg!;
    const src = toRecord(payload);
    const out = this.shallowPick(src, cfg.response.allowTopLevel);

    const choices = Array.isArray(src.choices) ? src.choices : [];
    out.choices = choices.map((choice, idx) => this.normalizeResponseChoice(choice, idx, cfg.response));

    if (src.usage && typeof src.usage === 'object') {
      out.usage = this.shallowPick(src.usage, cfg.response.usage?.allow || []);
    }
    return out;
  }

  private normalizeRequestMessages(messages: unknown, requestCfg: RequestConfig): UnknownObject[] {
    const entries = toArray(messages);
    const normalized = entries.map(entry => this.normalizeSingleMessage(entry, requestCfg));
    const withRules = this.applyMessageRules(normalized, requestCfg);
    this.pairToolResults(withRules);
    return withRules;
  }

  private normalizeSingleMessage(message: unknown, requestCfg: RequestConfig): UnknownObject {
    const msg = toRecord(message);
    const allowedRoles = requestCfg.messages.allowedRoles;
    const requestedRole = typeof msg.role === 'string' ? msg.role : undefined;
    const role = (requestedRole && allowedRoles.includes(requestedRole)) ? requestedRole : 'user';
    const normalized: UnknownObject = { role };

    if (role === 'tool') {
      normalized.content = this.normalizeToolContent(msg.content);
      if (typeof msg.name === 'string') {
        normalized.name = msg.name;
      }
      if (typeof msg.tool_call_id === 'string') {
        normalized.tool_call_id = msg.tool_call_id;
      }
    } else {
      normalized.content = (msg.content !== null && msg.content !== undefined) ? String(msg.content) : '';
    }

    if (role === 'assistant' && hasArrayItems(msg.tool_calls)) {
      normalized.tool_calls = this.normalizeAssistantToolCalls(msg.tool_calls, requestCfg);
      if (requestCfg.messages.assistantWithToolCallsContentNull) {
        normalized.content = null;
      }
    }

    return normalized;
  }

  private normalizeAssistantToolCalls(toolCalls: unknown, requestCfg: RequestConfig): UnknownObject[] {
    const entries = toArray(toolCalls);
    return entries.map(call => {
      const tc = toRecord(call);
      const fn = toRecord(tc.function);
      const name = typeof fn.name === 'string' ? fn.name : undefined;
      const argsValue = requestCfg.assistantToolCalls?.functionArgumentsType === 'string'
        ? this.toStringArgs(fn.arguments)
        : this.toObjectArgs(fn.arguments);
      const normalized: UnknownObject = {
        type: typeof tc.type === 'string' ? tc.type : 'function',
        function: { ...(name ? { name } : {}), arguments: argsValue }
      };
      if (typeof tc.id === 'string') {
        normalized.id = tc.id;
      }
      return normalized;
    });
  }

  private applyMessageRules(messages: UnknownObject[], requestCfg: RequestConfig): UnknownObject[] {
    const rules = Array.isArray(requestCfg.messagesRules) ? requestCfg.messagesRules : [];
    if (!rules.length) {
      if (requestCfg.messages.suppressAssistantToolCalls) {
        return messages.filter(msg => !(msg.role === 'assistant' && hasArrayItems(msg.tool_calls)));
      }
      return messages;
    }

    const result: UnknownObject[] = [];
    for (const message of messages) {
      let dropped = false;
      for (const rule of rules) {
        const when = rule.when || {};
        const matchRole = when.role ? message.role === when.role : true;
        const hasTools = hasArrayItems(message.tool_calls);
        const matchTools = typeof when.hasToolCalls === 'boolean' ? hasTools === when.hasToolCalls : true;
        if (matchRole && matchTools) {
          if (rule.action === 'drop') {
            dropped = true;
            break;
          }
          if (rule.action === 'set' && rule.set && typeof rule.set === 'object') {
            Object.assign(message, rule.set);
          }
        }
      }
      if (!dropped) {
        result.push(message);
      }
    }
    return result;
  }

  private pairToolResults(messages: UnknownObject[]): void {
    const nameById = new Map<string, string>();
    for (const message of messages) {
      if (message.role === 'assistant' && hasArrayItems(message.tool_calls)) {
        for (const call of message.tool_calls as unknown[]) {
          const toolCall = toRecord(call);
          if (typeof toolCall.id !== 'string') {
            continue;
          }
          const fn = toRecord(toolCall.function);
          if (typeof fn.name === 'string') {
            nameById.set(toolCall.id, fn.name);
          }
        }
      }
    }

    for (const message of messages) {
      if (message.role !== 'tool') {
        continue;
      }
      const name = typeof message.name === 'string' ? message.name.trim() : '';
      if (name) {
        continue;
      }
      const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined;
      if (toolCallId && nameById.has(toolCallId)) {
        message.name = nameById.get(toolCallId);
      }
    }
  }

  private normalizeTools(container: UnknownObject, requestCfg: RequestConfig): void {
    if (!Array.isArray(container.tools)) {
      return;
    }
    if (!requestCfg.tools?.normalize) {
      if (requestCfg.tools?.forceToolChoiceAuto) {
        container.tool_choice = 'auto';
      }
      return;
    }

    const normalized: UnknownObject[] = [];
    for (const toolEntry of container.tools as unknown[]) {
      const normalizedTool = this.normalizeSingleTool(toolEntry);
      normalized.push(normalizedTool);
    }
    container.tools = normalized;
    if (requestCfg.tools?.forceToolChoiceAuto) {
      container.tool_choice = 'auto';
    }
  }

  private normalizeSingleTool(toolEntry: unknown): UnknownObject {
    const tool = toRecord(toolEntry);
    const fnTop = {
      name: typeof tool.name === 'string' ? tool.name : undefined,
      description: typeof tool.description === 'string' ? tool.description : undefined,
      parameters: tool.parameters
    };
    const fn = toRecord(tool.function);
    const name = typeof fn.name === 'string' ? fn.name : fnTop.name;
    const description = typeof fn.description === 'string' ? fn.description : fnTop.description;
    let parameters = fn.parameters !== undefined ? fn.parameters : fnTop.parameters;
    parameters = this.normalizeToolParameters(parameters, name);

    const normalizedFn: UnknownObject = {
      ...(name ? { name } : {}),
      ...(description ? { description } : {})
    };
    if (parameters !== undefined) {
      normalizedFn.parameters = parameters;
    }

    return {
      type: 'function',
      function: normalizedFn
    };
  }

  private normalizeToolParameters(input: unknown, name: string | undefined): UnknownObject | undefined {
    if (input === null || input === undefined) {
      return undefined;
    }
    let params: UnknownObject | undefined;
    if (typeof input === 'string') {
      try { params = JSON.parse(input) as UnknownObject; }
      catch { params = undefined; }
    } else if (isRecord(input)) {
      params = input;
    }
    if (!params) {
      return undefined;
    }
    if (name && name.trim().toLowerCase() === 'shell') {
      return this.enforceShellSchema(params);
    }
    return params;
  }

  private enforceShellSchema(schema: UnknownObject): UnknownObject {
    const next = { ...schema };
    if (typeof next.type !== 'string') {
      next.type = 'object';
    }
    if (!isRecord(next.properties)) {
      next.properties = {};
    }
    const props = next.properties as UnknownObject;
    const command = toRecord(props.command);
    const hasOneOf = Array.isArray(command.oneOf);
    if (!hasOneOf) {
      const descText = typeof command.description === 'string'
        ? command.description
        : 'Shell command. Prefer a single string; an array of argv tokens is also accepted.';
      props.command = {
        description: descText,
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } }
        ]
      };
      const requiredList = Array.isArray(next.required)
        ? (next.required as unknown[]).filter((item): item is string => typeof item === 'string')
        : [];
      if (!requiredList.includes('command')) {
        requiredList.push('command');
      }
      next.required = requiredList;
      if (typeof next.additionalProperties !== 'boolean') {
        next.additionalProperties = false;
      }
    }
    return next;
  }

  private cleanupToolChoice(container: UnknownObject): void {
    const toolsArray = Array.isArray(container.tools) ? container.tools : [];
    if (!toolsArray.length && Object.prototype.hasOwnProperty.call(container, 'tool_choice')) {
      delete container.tool_choice;
    }
  }

  private normalizeResponseChoice(choice: unknown, idx: number, responseCfg: ResponseConfig): UnknownObject {
    const choiceRecord = toRecord(choice);
    const normalized: UnknownObject = {
      index: typeof choiceRecord.index === 'number' ? choiceRecord.index : idx
    };
    const message = toRecord(choiceRecord.message);
    normalized.message = this.normalizeResponseMessage(message, responseCfg);
    const hasToolCalls = hasArrayItems((normalized.message as UnknownObject).tool_calls);
    normalized.finish_reason = choiceRecord.finish_reason ?? (hasToolCalls ? 'tool_calls' : null);
    return normalized;
  }

  private normalizeResponseMessage(message: UnknownObject, responseCfg: ResponseConfig): UnknownObject {
    const normalized: UnknownObject = {};
    normalized.role = typeof message.role === 'string'
      ? message.role
      : (responseCfg.choices.message.roleDefault || 'assistant');

    if (hasArrayItems(message.tool_calls)) {
      normalized.tool_calls = this.normalizeResponseToolCalls(message.tool_calls, responseCfg);
      normalized.content = responseCfg.choices.message.contentNullWhenToolCalls ? null : message.content ?? '';
    } else {
      normalized.content = message.content ?? '';
    }
    if (typeof message.reasoning_content === 'string') {
      normalized.reasoning_content = message.reasoning_content;
    }
    if (message.audio) {
      normalized.audio = message.audio;
    }
    return normalized;
  }

  private normalizeResponseToolCalls(toolCalls: unknown, responseCfg: ResponseConfig): UnknownObject[] {
    const entries = toArray(toolCalls);
    return entries.map(call => {
      const tc = toRecord(call);
      const fn = toRecord(tc.function);
      const name = typeof fn.name === 'string' ? fn.name : undefined;
      const argsObject = this.toObjectArgs(fn.arguments);
      const argsValue = responseCfg.choices.message.tool_calls?.function?.argumentsType === 'string'
        ? this.toStringArgs(argsObject)
        : argsObject;
      const normalized: UnknownObject = {
        type: typeof tc.type === 'string' ? tc.type : 'function',
        function: { ...(name ? { name } : {}), arguments: argsValue }
      };
      if (typeof tc.id === 'string') {
        normalized.id = tc.id;
      }
      if (tc.mcp) {
        const existing = isRecord(normalized._glm) ? normalized._glm : {};
        normalized._glm = { ...existing, mcp: tc.mcp };
      }
      return normalized;
    });
  }
}
