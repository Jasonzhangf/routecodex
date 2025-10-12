/**
 * Reasoning Filter Workflow
 *
 * Presentation-time sanitizer for protocol-specific response payloads.
 * - For Anthropics targets: allow only text/tool_use; drop/flatten non-standard reasoning fields
 * - For OpenAI targets: keep or merge reasoning_content per configuration
 *
 * Config (example):
 * {
 *   type: "workflow-reasoning-filter",
 *   config: {
 *     reasoningPolicy: {
 *       anthropic: { disposition: "drop", strict: true },
 *       openai: { disposition: "keep" } // or "safe_text"
 *     }
 *   }
 * }
 */

import type { WorkflowModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest } from '../../../../types/shared-dtos.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';

type TargetProtocol = 'anthropic' | 'openai';

export class ReasoningFilterWorkflow implements WorkflowModule {
  readonly id: string;
  readonly type = 'workflow-reasoning-filter';
  readonly workflowType = 'response-presentation';
  readonly config: ModuleConfig;
  private logger: PipelineDebugLogger;
  private isInitialized = false;
  private protocolByReq: Map<string, TargetProtocol> = new Map();

  constructor(config: ModuleConfig, deps: ModuleDependencies) {
    this.id = `workflow-reasoning-filter-${Date.now()}`;
    this.config = config;
    this.logger = deps.logger as any;
  }

  async initialize(): Promise<void> {
    this.validateConfig();
    this.isInitialized = true;
    this.logger.logModule(this.id, 'initialized', { config: this.config });
  }

  async processIncoming(request: SharedPipelineRequest): Promise<SharedPipelineRequest> {
    if (!this.isInitialized) throw new Error('ReasoningFilter not initialized');
    try {
      const reqId = request?.route?.requestId || '';
      // Determine target protocol from metadata when present (set by HTTP layer)
      const md: any = (request as any)?.metadata || {};
      const explicit = typeof md?.targetProtocol === 'string' ? String(md.targetProtocol).toLowerCase() : undefined;
      const endpoint = String(md?.endpoint || md?.url || '');
      let proto: TargetProtocol = explicit === 'anthropic' ? 'anthropic' : (explicit === 'openai' ? 'openai' : this.detectByEndpoint(endpoint));
      if (reqId) this.protocolByReq.set(reqId, proto);
      return request;
    } catch (e) {
      this.logger.logModule(this.id, 'process-incoming-error', { error: (e as Error).message });
      return request;
    }
  }

  async processOutgoing(response: any): Promise<any> {
    if (!this.isInitialized) throw new Error('ReasoningFilter not initialized');
    const isDto = response && typeof response === 'object' && 'data' in response && 'metadata' in response;
    const dto = isDto ? (response as any) : { data: response, metadata: {} };
    const reqId: string = String(dto?.metadata?.requestId || '');
    const proto: TargetProtocol = (reqId && this.protocolByReq.has(reqId)) ? this.protocolByReq.get(reqId)! : 'openai';
    const policy = this.getPolicy(proto);
    let data = dto.data;
    try {
      if (proto === 'anthropic') {
        data = this.sanitizeForAnthropic(data, policy);
      } else {
        data = this.sanitizeForOpenAI(data, policy);
      }
      // Return in same envelope shape
      if (isDto) {
        return { ...dto, data };
      }
      return data;
    } catch (e) {
      this.logger.logModule(this.id, 'process-outgoing-error', { error: (e as Error).message });
      return response;
    } finally {
      // Cleanup memory for this request to avoid leaks
      if (reqId) this.protocolByReq.delete(reqId);
    }
  }

  async cleanup(): Promise<void> {
    this.protocolByReq.clear();
    this.isInitialized = false;
  }

  getStatus() {
    return {
      id: this.id, type: this.type, workflowType: this.workflowType,
      isInitialized: this.isInitialized, lastActivity: Date.now()
    };
  }

  // --- Internals ---
  private detectByEndpoint(endpoint: string): TargetProtocol {
    if (endpoint.includes('/v1/messages') || endpoint.includes('/v1/anthropic/messages')) return 'anthropic';
    return 'openai';
  }

  private getPolicy(proto: TargetProtocol) {
    const cfg = (this.config?.config as any)?.reasoningPolicy || {};
    if (proto === 'anthropic') {
      const a = cfg.anthropic || {};
      return {
        disposition: a.disposition === 'text' ? 'text' : 'drop',
        strict: a.strict !== false
      };
    }
    const o = cfg.openai || {};
    return {
      disposition: o.disposition === 'safe_text' ? 'safe_text' : 'keep'
    };
  }

  // OpenAI ChatCompletion object -> sanitize reasoning fields
  private sanitizeForOpenAI(payload: any, policy: { disposition: 'keep' | 'safe_text' }): any {
    try {
      const obj = (payload && typeof payload === 'object') ? { ...payload } : payload;
      if (!obj || typeof obj !== 'object' || !Array.isArray(obj.choices)) return obj;
      obj.choices = obj.choices.map((c: any) => this.cleanOpenAIChoice(c, policy));
      return obj;
    } catch { return payload; }
  }

  private cleanOpenAIChoice(choiceIn: any, policy: { disposition: 'keep' | 'safe_text' }): any {
    const c = (choiceIn && typeof choiceIn === 'object') ? { ...choiceIn } : choiceIn;
    if (!c || typeof c !== 'object') return c;
    const msg = (c.message && typeof c.message === 'object') ? { ...c.message } : c.message;
    if (!msg || typeof msg !== 'object') return c;
    // Normalize message.content to string
    msg.content = this.mergeContentToString(msg.content);
    // Handle reasoning_content
    if ('reasoning_content' in msg) {
      if (policy.disposition === 'safe_text') {
        const rc = msg.reasoning_content;
        const rcStr = this.mergeContentToString(rc);
        msg.content = msg.content ? String(msg.content) : '';
        msg.content = msg.content ? `${msg.content}\n${rcStr}` : rcStr;
        delete (msg as any).reasoning_content;
      } else {
        // keep: but ensure it's a string to avoid client errors
        (msg as any).reasoning_content = this.mergeContentToString((msg as any).reasoning_content);
      }
    }
    // Remove common non-standard thought fields if any leaked
    delete (msg as any).thought;
    delete (msg as any).thinking;
    c.message = msg;
    return c;
  }

  private mergeContentToString(content: any): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const texts = content.map((it) => {
        if (typeof it === 'string') return it;
        if (it && typeof it === 'object' && typeof (it as any).text === 'string') return (it as any).text;
        return '';
      }).filter(Boolean);
      return texts.join('');
    }
    if (content && typeof content === 'object' && typeof (content as any).text === 'string') return (content as any).text;
    try { return JSON.stringify(content ?? ''); } catch { return String(content ?? ''); }
  }

  // For Anthropics target: prepare OpenAI-shaped response for converter; drop/flatten non-standard fields
  private sanitizeForAnthropic(payload: any, policy: { disposition: 'drop' | 'text'; strict: boolean }): any {
    try {
      const obj = (payload && typeof payload === 'object') ? { ...payload } : payload;
      if (!obj || typeof obj !== 'object' || !Array.isArray(obj.choices)) return obj;
      obj.choices = obj.choices.map((c: any) => this.cleanAnthropicChoice(c, policy));
      return obj;
    } catch { return payload; }
  }

  private cleanAnthropicChoice(choiceIn: any, policy: { disposition: 'drop' | 'text'; strict: boolean }): any {
    const c = (choiceIn && typeof choiceIn === 'object') ? { ...choiceIn } : choiceIn;
    if (!c || typeof c !== 'object') return c;
    const msg = (c.message && typeof c.message === 'object') ? { ...c.message } : c.message;
    if (!msg || typeof msg !== 'object') return c;
    // Normalize message.content to string to avoid array/object content leaking into anthropic blocks
    msg.content = this.mergeContentToString(msg.content);
    // Drop or convert reasoning_content
    if ('reasoning_content' in msg) {
      if (policy.disposition === 'text') {
        const rcStr = this.mergeContentToString((msg as any).reasoning_content);
        msg.content = msg.content ? `${msg.content}\n${rcStr}` : rcStr;
      }
      delete (msg as any).reasoning_content;
    }
    // Remove potential non-standard fields
    delete (msg as any).thought;
    delete (msg as any).thinking;
    c.message = msg;
    return c;
  }

  private validateConfig(): void {
    if (!this.config || this.config.type !== 'workflow-reasoning-filter') {
      throw new Error('Invalid ReasoningFilter configuration');
    }
  }
}

