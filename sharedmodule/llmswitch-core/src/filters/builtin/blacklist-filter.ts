import type { Filter, FilterContext, FilterResult, JsonObject } from '../types.js';

export class BlacklistFilter implements Filter<JsonObject> {
  readonly name = 'blacklist';
  readonly stage;
  private readonly deny: Set<string>;
  constructor(stage: FilterContext['stage'], deny: string[]) {
    this.stage = stage;
    this.deny = new Set(deny || []);
  }
  apply(input: JsonObject): FilterResult<JsonObject> {
    if (!input || typeof input !== 'object') return { ok: true, data: input };
    const out: JsonObject = JSON.parse(JSON.stringify(input));
    for (const k of Object.keys(out)) { if (this.deny.has(k)) delete (out as any)[k]; }
    return { ok: true, data: out };
  }
}

