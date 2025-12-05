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

  private static isRecord(value: unknown): value is UnknownObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private static removeKeys(target: UnknownObject, keys: readonly string[]): void {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(target, key)) {
        delete target[key];
      }
    }
  }

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
    if (off === '1' || off === 'true' || off === 'yes') {
      return payload;
    }

    const cfg = this.cfg!;
    const out: UnknownObject = BlacklistSanitizer.isRecord(payload) ? payload : {};

    // 1) tools[].function key blacklist
    try {
      const removeKeys = cfg?.request?.tools?.function?.removeKeys || [];
      if (Array.isArray((out as Record<string, unknown>).tools) && removeKeys.length) {
        for (const tool of (out as Record<string, unknown>).tools as unknown[]) {
          try {
            if (!BlacklistSanitizer.isRecord(tool)) { continue; }
            const fnCandidate = tool.function;
            if (BlacklistSanitizer.isRecord(fnCandidate)) {
              BlacklistSanitizer.removeKeys(fnCandidate, removeKeys);
            }
          } catch { /* ignore single tool errors */ }
        }
      }
    } catch { /* ignore tools stage */ }

    // 2) messages[assistant].tool_calls[].function key blacklist
    try {
      const rmMsgKeys = cfg?.request?.messages?.assistantToolCalls?.function?.removeKeys || [];
      if (Array.isArray((out as Record<string, unknown>).messages) && rmMsgKeys.length) {
        for (const message of (out as Record<string, unknown>).messages as unknown[]) {
          try {
            if (!BlacklistSanitizer.isRecord(message)) { continue; }
            if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
              for (const toolCall of message.tool_calls as unknown[]) {
                try {
                  if (!BlacklistSanitizer.isRecord(toolCall)) { continue; }
                  const fnCandidate = toolCall.function;
                  if (BlacklistSanitizer.isRecord(fnCandidate)) {
                    BlacklistSanitizer.removeKeys(fnCandidate, rmMsgKeys);
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
          const has = Array.isArray((out as Record<string, unknown>).tools) && ((out as Record<string, unknown>).tools as unknown[]).length > 0;
          matched = !has;
        } else if (when.tools === 'present') {
          const has = Array.isArray((out as Record<string, unknown>).tools) && ((out as Record<string, unknown>).tools as unknown[]).length > 0;
          matched = has;
        }
        if (matched) {
          for (const key of remove) {
            if (Object.prototype.hasOwnProperty.call(out, key)) {
              delete (out as Record<string, unknown>)[key];
            }
          }
        }
      }
    } catch { /* ignore top-level stage */ }

    return out as UnknownObject;
  }
}
