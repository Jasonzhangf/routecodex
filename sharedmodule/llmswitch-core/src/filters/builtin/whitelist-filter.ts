import type { Filter, FilterContext, FilterResult, JsonObject } from '../types.js';

export class WhitelistFilter implements Filter<JsonObject> {
  readonly name = 'whitelist';
  readonly stage;
  private readonly allow: Set<string>;
  constructor(stage: FilterContext['stage'], allow: string[]) {
    this.stage = stage;
    this.allow = new Set(allow || []);
  }
  apply(input: JsonObject): FilterResult<JsonObject> {
    if (!input || typeof input !== 'object') return { ok: true, data: input };
    const out: JsonObject = {};
    for (const k of Object.keys(input)) { if (this.allow.has(k)) (out as any)[k] = (input as any)[k]; }
    return { ok: true, data: out };
  }
}

