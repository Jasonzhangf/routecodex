import * as fs from 'fs/promises';
import * as path from 'path';
import type { UnknownObject } from '../../../../../types/common-types.js';

type ResponseBlacklistConfig = {
  // Only apply on non-stream paths; base layer already guards by endpoint
  paths?: string[]; // dot-paths; supports array wildcard via [] (e.g., choices[].message.foo)
  // Optional critical keeps (will never be removed even if listed in paths)
  keepCritical?: boolean;
};

/**
 * ResponseBlacklistSanitizer (configurable)
 * - Applies only on non-stream paths (caller ensures via endpoint guard)
 * - Config-driven removal of non-critical fields; path wildcard [] supported for arrays
 * - Protects critical fields regardless of config
 */
export class ResponseBlacklistSanitizer {
  private initialized = false;
  private cfg: ResponseBlacklistConfig | null = null;
  private readonly configPath?: string;
  private readonly inlineConfig?: ResponseBlacklistConfig;

  constructor(options: { configPath?: string; config?: ResponseBlacklistConfig } = {}) {
    this.configPath = options.configPath;
    this.inlineConfig = options.config;
  }

  async initialize(): Promise<void> {
    if (this.inlineConfig) { this.cfg = this.inlineConfig; this.initialized = true; return; }
    const file = this.configPath ? (path.isAbsolute(this.configPath) ? this.configPath : path.join(process.cwd(), this.configPath)) : '';
    if (file) {
      try {
        const text = await fs.readFile(file, 'utf-8');
        this.cfg = JSON.parse(text) as ResponseBlacklistConfig;
        this.initialized = true;
        return;
      } catch { /* fallthrough to default */ }
    }
    // Default minimal config
    this.cfg = {
      paths: [
        'usage.prompt_tokens_details.cached_tokens'
      ],
      keepCritical: true
    };
    this.initialized = true;
  }

  private readonly criticalPaths = new Set<string>([
    'status',
    'output',
    'output_text',
    'required_action',
    'choices[].message.content',
    'choices[].message.tool_calls',
    'choices[].finish_reason'
  ]);

  private isCritical(pathStr: string): boolean {
    if (!this.cfg?.keepCritical) return false;
    return this.criticalPaths.has(pathStr);
  }

  private deleteByPath(obj: any, pathStr: string): void {
    const tokens = pathStr.split('.');
    const recurse = (cur: any, idx: number): void => {
      if (!cur || typeof cur !== 'object') return;
      if (idx >= tokens.length) return;
      const token = tokens[idx];
      const isArrayWildcard = token.endsWith('[]');
      const key = isArrayWildcard ? token.slice(0, -2) : token;
      if (idx === tokens.length - 1) {
        // leaf deletion
        if (isArrayWildcard) {
          const arr = cur[key];
          if (Array.isArray(arr)) {
            for (const item of arr) {
              // cannot delete array item itself without key; no-op at leaf wildcard
            }
          }
        } else {
          if (Object.prototype.hasOwnProperty.call(cur, key)) delete cur[key];
        }
        return;
      }
      // intermediate traversal
      if (isArrayWildcard) {
        const arr = cur[key];
        if (Array.isArray(arr)) {
          for (const item of arr) recurse(item, idx + 1);
        }
      } else {
        recurse(cur[key], idx + 1);
      }
    };
    recurse(obj, 0);
  }

  async apply(payload: UnknownObject): Promise<UnknownObject> {
    if (!this.initialized) await this.initialize();
    const out: any = payload || {};
    try {
      const root: any = (out && typeof out === 'object' && 'data' in out) ? (out as any).data : out;
      const paths = Array.isArray(this.cfg?.paths) ? this.cfg!.paths! : [];
      for (const p of paths) {
        if (typeof p !== 'string' || !p) continue;
        if (this.isCritical(p)) continue;
        this.deleteByPath(root, p);
      }
      return out as UnknownObject;
    } catch {
      return out as UnknownObject;
    }
  }
}
