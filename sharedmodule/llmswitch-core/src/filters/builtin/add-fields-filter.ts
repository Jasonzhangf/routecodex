import type { Filter, FilterContext, FilterResult, JsonObject } from '../types.js';

export class AddFieldsFilter implements Filter<JsonObject> {
  readonly name = 'add_fields';
  readonly stage;
  private readonly fields: Record<string, unknown>;
  constructor(stage: FilterContext['stage'], fields: Record<string, unknown>) {
    this.stage = stage;
    this.fields = fields || {};
  }
  apply(input: JsonObject): FilterResult<JsonObject> {
    const out: JsonObject = JSON.parse(JSON.stringify(input || {}));
    for (const [k, v] of Object.entries(this.fields)) { (out as any)[k] = v; }
    return { ok: true, data: out };
  }
}

