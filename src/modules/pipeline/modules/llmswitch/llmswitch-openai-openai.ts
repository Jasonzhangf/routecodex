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
          }
        } catch { /* ignore */ }

        // 1) STRICT: validate assistant.tool_calls names and arguments
        for (const m of msgs) {
          if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            m.tool_calls = m.tool_calls.map((tc: any, idx: number) => {
              if (!tc || typeof tc !== 'object') return tc;
              const fn = { ...(tc.function || {}) };
              const name = typeof fn.name === 'string' ? fn.name : undefined;
              if (!name || !toolSchemas.has(name)) {
                const e: any = new Error(`Invalid tool name at assistant.tool_calls[${idx}]`);
                e.status = 400; throw e;
              }
              // arguments must be a JSON string
              if (fn.arguments === undefined || typeof fn.arguments !== 'string') {
                const e: any = new Error(`Invalid arguments type for tool '${name}': must be JSON string`);
                e.status = 400; throw e;
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
                        if (Array.isArray(arr)) {
                          (parsed as any).command = arr;
                        } else {
                          (parsed as any).command = [s];
                        }
                      } catch {
                        (parsed as any).command = [s];
                      }
                    } else {
                      (parsed as any).command = [s];
                    }
                  }
                  const finalCmd = (parsed as any).command;
                  const isArr = Array.isArray(finalCmd) && finalCmd.every((x: any) => typeof x === 'string');
                  if (!isArr) {
                    const e: any = new Error(`Invalid 'command' for tool '${name}': expected array<string>`);
                    e.status = 400; throw e;
                  }
                }
                // Persist possibly-normalized arguments
                fn.arguments = JSON.stringify(parsed);
              } catch (err) {
                if ((err as any)?.status) { throw err; }
                const e: any = new Error(`Invalid JSON in arguments for tool '${name || 'unknown'}'`);
                e.status = 400; throw e;
              }
              return { ...tc, function: fn };
            });
            // OpenAI 规范：当包含 tool_calls 时，assistant.content 为空串
            if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
              if (m.content === null || typeof m.content !== 'string') { m.content = ''; }
            }
          }
        }

        // 2) Pair tool results with the latest assistant.tool_calls and textify content
        //    Build a FIFO queue of pending call_ids from the last assistant with tool_calls
        let pending: string[] = [];
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i];
          if (!m || typeof m !== 'object') continue;
          if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            // Push call ids in order
            for (const tc of m.tool_calls) {
              const id = typeof tc?.id === 'string' ? tc.id : undefined;
              if (id) pending.push(id);
            }
            continue;
          }
          if (m.role === 'tool') {
            // Textify content
            if (m.content !== undefined && typeof m.content !== 'string') {
              m.content = extractToolText(m.content);
            } else if (typeof m.content === 'string') {
              // Try to parse stringified JSON and extract text
              const s = (m.content as string).trim();
              if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
                try {
                  const parsed = JSON.parse(s);
                  m.content = extractToolText(parsed);
                } catch { /* keep original */ }
              }
            }
            // Pair tool_call_id if missing
            if (!m.tool_call_id || typeof m.tool_call_id !== 'string') {
              if (pending.length === 0) {
                // No available call id to pair; strict mode: throw
                const e: any = new Error('Unpaired tool result: missing tool_call_id and no pending assistant.tool_calls');
                e.status = 400;
                throw e;
              }
              m.tool_call_id = pending.shift();
            } else {
              // If present but not in pending, accept as-is (could be from older turn)
              // Optionally we could realign, but strict pairing beyond this might be too aggressive here.
              // No-op
            }
          }
        }

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
    const payload = isDto ? (response as any).data : response;
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
