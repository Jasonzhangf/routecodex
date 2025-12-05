import * as fs from 'fs/promises';
import * as path from 'path';
import type { UnknownObject } from '../../../modules/pipeline/types/common-types.js';

type ResponseBlacklistConfig = {
  // Only apply on non-stream paths; base layer already guards by endpoint
  paths?: string[]; // dot-paths; supports array wildcard via [] (e.g., choices[].message.foo)
  // Optional critical keeps (will never be removed even if listed in paths)
  keepCritical?: boolean;
};

type Traversable = UnknownObject | unknown[];

function isRecord(value: unknown): value is UnknownObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTraversable(value: unknown): value is Traversable {
  return Array.isArray(value) || isRecord(value);
}

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
    if (!this.cfg?.keepCritical) {
      return false;
    }
    return this.criticalPaths.has(pathStr);
  }

  private unwrapPayload(payload: UnknownObject): UnknownObject {
    if (!isRecord(payload)) {
      return {};
    }
    const rootCandidate = payload.data;
    return isRecord(rootCandidate) ? rootCandidate : payload;
  }

  private deleteByPath(obj: unknown, pathStr: string): void {
    const tokens = pathStr.split('.');
    const recurse = (current: unknown, idx: number): void => {
      if (!isTraversable(current)) {
        return;
      }
      if (idx >= tokens.length) {
        return;
      }
      const token = tokens[idx];
      const isArrayWildcard = token.endsWith('[]');
      const key = isArrayWildcard ? token.slice(0, -2) : token;
      if (idx === tokens.length - 1) {
        // leaf deletion
        if (isArrayWildcard) {
          // Leaf wildcard removal is undefined; no-op to avoid destructive behavior
        } else {
          if (isRecord(current) && Object.prototype.hasOwnProperty.call(current, key)) {
            delete current[key];
          }
        }
        return;
      }
      // intermediate traversal
      if (isArrayWildcard) {
        if (isRecord(current)) {
          const arr = current[key];
          if (Array.isArray(arr)) {
            for (const item of arr) {
              recurse(item, idx + 1);
            }
          }
        }
      } else {
        if (isRecord(current)) {
          recurse(current[key], idx + 1);
        }
      }
    };
    recurse(obj, 0);
  }

  async apply(payload: UnknownObject): Promise<UnknownObject> {
    if (!this.initialized) {
      await this.initialize();
    }
    const out: UnknownObject = isRecord(payload) ? payload : {};
    try {
      const root = this.unwrapPayload(out);
      const configPaths = Array.isArray(this.cfg?.paths) ? this.cfg?.paths ?? [] : [];
      for (const p of configPaths) {
        if (typeof p !== 'string' || !p) { continue; }
        if (this.isCritical(p)) { continue; }
        this.deleteByPath(root, p);
      }
      return out;
    } catch {
      return out;
    }
  }
}
