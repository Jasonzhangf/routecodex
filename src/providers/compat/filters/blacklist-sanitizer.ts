import * as fs from 'fs/promises';
import * as path from 'path';
import type { UnknownObject } from '../../../modules/pipeline/types/common-types.js';

type ConditionalRule = {
  when?: { tools?: 'empty' | 'present' };
  remove?: string[];
};

type BlacklistConfig = {
  request: {
    tools?: { function?: { removeKeys?: string[] } };
    messages?: { assistantToolCalls?: { function?: { removeKeys?: string[] } } };
    topLevel?: { conditional?: ConditionalRule[] };
  };
};

/**
 * BlacklistSanitizer
 * - Minimal, key-level deletion for provider-incompatible fields (e.g., function.strict)
 * - Config-driven; no schema rebuild; safe in compatibility layer
 */
export class BlacklistSanitizer {
  private cfg: BlacklistConfig | null = null;
  private readonly configPath?: string;
  private readonly inlineConfig?: BlacklistConfig;

  constructor(options: { configPath?: string; config?: BlacklistConfig } = {}) {
    this.configPath = options.configPath;
    this.inlineConfig = options.config;
  }

  async initialize(): Promise<void> {
    if (this.inlineConfig) { this.cfg = this.inlineConfig; return; }
    const file = this.configPath ? (path.isAbsolute(this.configPath) ? this.configPath : path.join(process.cwd(), this.configPath)) : '';
    if (file) {
      try {
        const text = await fs.readFile(file, 'utf-8');
        this.cfg = JSON.parse(text) as BlacklistConfig;
        return;
      } catch { /* fallthrough to default */ }
    }
    // Default minimal rules for GLM 1210 mitigation
    this.cfg = {
      request: {
        tools: { function: { removeKeys: ['strict', 'json_schema'] } },
        messages: { assistantToolCalls: { function: { removeKeys: ['strict'] } } },
        topLevel: { conditional: [ { when: { tools: 'empty' }, remove: ['tool_choice'] } ] }
      }
    } as BlacklistConfig;
  }

  async apply(payload: UnknownObject): Promise<UnknownObject> {
    // Allow disabling via env
    const off = String(process.env.RCC_GLM_BLACKLIST_OFF || '0').toLowerCase();
    if (off === '1' || off === 'true' || off === 'yes') return payload;

    const cfg = this.cfg!;
    const out: any = payload || {};

    // 1) tools[].function key blacklist
    try {
      const removeKeys = cfg?.request?.tools?.function?.removeKeys || [];
      if (Array.isArray(out.tools) && removeKeys.length) {
        for (const t of out.tools as any[]) {
          try {
            const fn = t?.function;
            if (fn && typeof fn === 'object') {
              for (const k of removeKeys) { if (Object.prototype.hasOwnProperty.call(fn, k)) delete (fn as any)[k]; }
            }
          } catch { /* ignore single tool errors */ }
        }
      }
    } catch { /* ignore tools stage */ }

    // 2) messages[assistant].tool_calls[].function key blacklist
    try {
      const rmMsgKeys = cfg?.request?.messages?.assistantToolCalls?.function?.removeKeys || [];
      if (Array.isArray(out.messages) && rmMsgKeys.length) {
        for (const m of out.messages as any[]) {
          try {
            if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
              for (const tc of m.tool_calls as any[]) {
                try {
                  const fn = tc?.function;
                  if (fn && typeof fn === 'object') {
                    for (const k of rmMsgKeys) { if (Object.prototype.hasOwnProperty.call(fn, k)) delete (fn as any)[k]; }
                  }
                } catch { /* ignore single tool_call */ }
              }
            }
          } catch { /* ignore single message */ }
        }
      }
    } catch { /* ignore messages stage */ }

    // 3) top-level conditional removals
    try {
      const conds = cfg?.request?.topLevel?.conditional || [];
      for (const c of conds) {
        const when = c?.when || {};
        const remove = c?.remove || [];
        let matched = false;
        if (when.tools === 'empty') {
          const has = Array.isArray(out.tools) && (out.tools as any[]).length > 0;
          matched = !has;
        } else if (when.tools === 'present') {
          const has = Array.isArray(out.tools) && (out.tools as any[]).length > 0;
          matched = has;
        }
        if (matched) {
          for (const key of remove) {
            if (Object.prototype.hasOwnProperty.call(out, key)) delete out[key];
          }
        }
      }
    } catch { /* ignore top-level stage */ }

    return out as UnknownObject;
  }
}

