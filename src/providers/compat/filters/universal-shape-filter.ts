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

  private shallowPick(obj: any, allow: string[]): any {
    if (!obj || typeof obj !== 'object') return obj;
    const out: any = {};
    for (const k of allow) { if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k]; }
    return out;
  }

  private toObjectArgs(v: any): any {
    if (v == null) return {};
    if (typeof v === 'object') return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return { raw: v }; } }
    return {};
  }

  async applyRequestFilter(payload: UnknownObject): Promise<UnknownObject> {
    const cfg = this.cfg!;

    const allow = new Set(cfg.request.allowTopLevel);
    const src: any = payload || {};
    const out: any = {};
    for (const k of Object.keys(src)) { if (allow.has(k)) out[k] = src[k]; }

    const msgs = Array.isArray(out.messages) ? out.messages : [];
    const mapped = msgs.map((m: any) => {
      const role = (typeof m?.role === 'string' && cfg.request.messages.allowedRoles.includes(m.role)) ? m.role : 'user';
      const base: any = { role };
      if (role === 'tool') {
        const s = typeof m?.content === 'string' ? m.content : (m?.content != null ? JSON.stringify(m.content) : 'Command succeeded (no output).');
        base.content = s && s.trim().length ? s : 'Command succeeded (no output).';
      } else {
        base.content = (m?.content != null) ? String(m.content) : '';
      }
      if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
        base.tool_calls = (m.tool_calls as any[]).map(tc => {
          const fn = tc?.function || {};
          const name = typeof fn?.name === 'string' ? fn.name : undefined;
          const args = (cfg.request.assistantToolCalls?.functionArgumentsType === 'string') ? (typeof fn?.arguments === 'string' ? fn.arguments : JSON.stringify(fn?.arguments ?? {})) : this.toObjectArgs(fn?.arguments);
          const outTc: any = { type: 'function', function: { ...(name?{name}:{ }), arguments: args } };
          if (tc?.id) outTc.id = tc.id;
          return outTc;
        });
        if (cfg.request.messages.assistantWithToolCallsContentNull) base.content = null;
      }
      if (role === 'tool') {
        if (typeof m?.name === 'string') base.name = m.name;
        if (typeof m?.tool_call_id === 'string') base.tool_call_id = m.tool_call_id;
      }
      return base;
    });
    // Apply generic messagesRules first (config-driven)
    const rules = Array.isArray(cfg.request.messagesRules) ? cfg.request.messagesRules : [];
    const applyRules = (arr: any[]): any[] => {
      if (!rules.length) return arr;
      const res: any[] = [];
      for (const m of arr) {
        let dropped = false;
        for (const r of rules) {
          const when = r.when || {};
          const matchRole = when.role ? (m?.role === when.role) : true;
          const hasTC = Array.isArray(m?.tool_calls) && m.tool_calls.length > 0;
          const matchTC = (typeof when.hasToolCalls === 'boolean') ? (hasTC === when.hasToolCalls) : true;
          const matched = matchRole && matchTC;
          if (matched) {
            if (r.action === 'drop') { dropped = true; break; }
            if (r.action === 'set' && r.set && typeof r.set === 'object') {
              Object.assign(m, r.set);
            }
            // keep = no-op
          }
        }
        if (!dropped) res.push(m);
      }
      return res;
    };
    let filtered = applyRules(mapped);
    // Back-compat: legacy boolean suppression if no rules provided
    if (!rules.length && cfg.request.messages.suppressAssistantToolCalls) {
      filtered = filtered.filter((m: any) => !(m?.role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length));
    }
    // Drop provider error echo messages (e.g., Error: HTTP 400: {"error":{...}}) to avoid contaminating next turn
    // Do not intercept/drop any request messages here.

    // Pair tool results with function name using previous assistant tool_calls
    try {
      const nameById = new Map<string, string>();
      for (const m of filtered) {
        if (m && (m as any).role === 'assistant' && Array.isArray((m as any).tool_calls)) {
          for (const tc of ((m as any).tool_calls as any[])) {
            const id = typeof tc?.id === 'string' ? tc.id : undefined;
            const fn = tc?.function || {};
            const nm = typeof fn?.name === 'string' ? fn.name : undefined;
            if (id && nm) { nameById.set(id, nm); }
          }
        }
      }
      for (const m of filtered) {
        if (m && (m as any).role === 'tool') {
          const hasName = typeof (m as any).name === 'string' && (m as any).name.trim().length > 0;
          const tid = typeof (m as any).tool_call_id === 'string' ? (m as any).tool_call_id : undefined;
          if (!hasName && tid && nameById.has(tid)) {
            (m as any).name = nameById.get(tid);
          }
        }
      }
    } catch { /* ignore pairing errors */ }

    out.messages = filtered;

    if (Array.isArray(out.tools) && cfg.request.tools?.normalize) {
      const norm: any[] = [];
      for (const t of out.tools) {
        try {
          const fnTop = { name: t?.name, description: t?.description, parameters: t?.parameters };
          const fn = (t && typeof t.function === 'object') ? t.function : {};
          const name = typeof fn?.name === 'string' ? fn.name : (typeof fnTop.name === 'string' ? fnTop.name : undefined);
          const desc = typeof fn?.description === 'string' ? fn.description : (typeof fnTop.description === 'string' ? fnTop.description : undefined);
          let params = (fn?.parameters !== undefined) ? fn.parameters : fnTop.parameters;
          if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = undefined; } }
          if (params && typeof params !== 'object') params = undefined;
          // Minimal provider-side safeguard: ensure shell.command prefers string with array compatibility
          try {
            if (typeof name === 'string' && name.trim().toLowerCase() === 'shell' && params && typeof params === 'object') {
              const pObj: any = params;
              if (pObj && typeof pObj === 'object') {
                if (typeof pObj.type !== 'string') pObj.type = 'object';
                if (!pObj.properties || typeof pObj.properties !== 'object') pObj.properties = {};
                const cmd = pObj.properties.command as any;
                const hasOneOf = !!(cmd && typeof cmd === 'object' && Array.isArray(cmd.oneOf));
                if (!hasOneOf) {
                  const descText = (cmd && typeof cmd.description === 'string') ? cmd.description : 'Shell command. Prefer a single string; an array of argv tokens is also accepted.';
                  pObj.properties.command = {
                    description: descText,
                    oneOf: [ { type: 'string' }, { type: 'array', items: { type: 'string' } } ]
                  };
                  const req: string[] = Array.isArray(pObj.required) ? pObj.required : [];
                  if (!req.includes('command')) req.push('command');
                  pObj.required = req;
                  if (typeof pObj.additionalProperties !== 'boolean') pObj.additionalProperties = false;
                  params = pObj;
                }
              }
            }
          } catch { /* keep original params on error */ }
          norm.push({ type:'function', function:{ ...(name?{name}:{ }), ...(desc?{description:desc}:{ }), ...(params?{parameters:params}:{ }) } });
        } catch { norm.push(t); }
      }
      out.tools = norm;
      if (cfg.request.tools?.forceToolChoiceAuto) out.tool_choice = 'auto';
    }
    // If no tools present, drop tool_choice to avoid upstream 1210
    try {
      const hasTools = Array.isArray(out.tools) && (out.tools as any[]).length > 0;
      if (!hasTools && Object.prototype.hasOwnProperty.call(out, 'tool_choice')) delete out.tool_choice;
    } catch { /* ignore */ }
    return out as UnknownObject;
  }

  async applyResponseFilter(payload: UnknownObject, _ctx?: CompatibilityContext): Promise<UnknownObject> {
    // Bypass shape filtering by default to keep system running; can be turned off via env.
    // Default: RCC_COMPAT_FILTER_OFF_RESPONSES is treated as ON unless explicitly set to 0/false/off.
    const envFlag = String(process.env.RCC_COMPAT_FILTER_OFF_RESPONSES || '1').toLowerCase();
    const envBypass = !(envFlag === '0' || envFlag === 'false' || envFlag === 'off');
    try {
      const entry = String((_ctx as any)?.entryEndpoint || (_ctx as any)?.endpoint || '').toLowerCase();
      if (entry === '/v1/responses' || envBypass) {
        return payload;
      }
    } catch { /* ignore */ if (envBypass) return payload; }
    const cfg = this.cfg!;
    const src: any = payload || {};
    const out: any = this.shallowPick(src, cfg.response.allowTopLevel);

    const choices = Array.isArray(src?.choices) ? src.choices : [];
    out.choices = choices.map((c: any, idx: number) => {
      const cc: any = { index: typeof c?.index === 'number' ? c.index : idx };
      const msg = c?.message || {};
      const m: any = {};
      m.role = typeof msg?.role === 'string' ? msg.role : (cfg.response.choices.message.roleDefault || 'assistant');
      if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length) {
        m.tool_calls = (msg.tool_calls as any[]).map(tc => {
          const fn = tc?.function || {};
          const name = typeof fn?.name === 'string' ? fn.name : undefined;
          const argsObj = this.toObjectArgs(fn?.arguments);
          let argsOut: any = argsObj;
          if (cfg.response.choices.message.tool_calls?.function?.argumentsType === 'string') {
            try { argsOut = JSON.stringify(argsObj ?? {}); } catch { argsOut = '{}'; }
          }
          const outTc: any = { type: tc?.type || 'function', function: { ...(name?{name}:{ }), arguments: argsOut } };
          if (tc?.id) outTc.id = tc.id;
          if (tc?.mcp) outTc._glm = { ...(outTc._glm||{}), mcp: tc.mcp };
          return outTc;
        });
        if (cfg.response.choices.message.contentNullWhenToolCalls) {
          m.content = null;
        } else if (msg?.content != null) {
          m.content = msg.content;
        }
      } else {
        m.content = msg?.content ?? '';
      }
      if (typeof msg?.reasoning_content === 'string') m.reasoning_content = msg.reasoning_content;
      if (msg?.audio) m.audio = msg.audio;
      cc.message = m;
      cc.finish_reason = c?.finish_reason || (Array.isArray(m.tool_calls) && m.tool_calls.length ? 'tool_calls' : (c?.finish_reason ?? null));
      return cc;
    });

    if (src?.usage && typeof src.usage === 'object') {
      out.usage = this.shallowPick(src.usage, cfg.response.usage?.allow || []);
    }
    return out as UnknownObject;
  }
}
