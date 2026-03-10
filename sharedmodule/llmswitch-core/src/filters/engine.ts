import type { Filter, FilterContext, FilterResult, FieldMapConfig, FieldMapRule, JsonObject } from './types.js';
import { writeFilterSnapshot } from './utils/snapshot-writer.js';

// Lightweight, dependency-free filter engine. Field-mapping supports a minimal dot-path subset.

export class FilterEngine {
  private readonly filters: Filter[] = [];
  private fieldMap?: FieldMapConfig;
  private readonly transforms: Record<string, (v: unknown) => unknown> = {};

  registerFilter(filter: Filter): void { this.filters.push(filter); }
  setFieldMap(config: FieldMapConfig): void { this.fieldMap = config; }
  registerTransform(name: string, fn: (v: unknown) => unknown): void { this.transforms[name] = fn; }

  async run(stage: FilterContext['stage'], payload: JsonObject, ctxBase: Omit<FilterContext,'stage'>): Promise<JsonObject> {
    let out: JsonObject = payload;
    const ctx: FilterContext = { ...ctxBase, stage } as FilterContext;
    try { await writeFilterSnapshot({ requestId: ctx.requestId, endpoint: ctx.endpoint, profile: ctx.profile, stage, tag: 'begin', data: out }); } catch { /* ignore */ }
    // stage pre filters
    for (const f of this.filters) {
      if (f.stage !== stage) continue;
      const res = await Promise.resolve(f.apply(out, ctx));
      if (!res.ok) continue; // keep last good state
      out = res.data;
      try { await writeFilterSnapshot({ requestId: ctx.requestId, endpoint: ctx.endpoint, profile: ctx.profile, stage, name: f.name, tag: 'after', data: out }); } catch { /* ignore */ }
    }
    // field map in map stages
    if (stage === 'request_map' || stage === 'response_map') {
      const rules = (stage === 'request_map') ? (this.fieldMap?.request || []) : (this.fieldMap?.response || []);
      try { await writeFilterSnapshot({ requestId: ctx.requestId, endpoint: ctx.endpoint, profile: ctx.profile, stage, tag: 'map_before', data: out }); } catch { /* ignore */ }
      out = this.applyFieldMap(out, rules);
      try { await writeFilterSnapshot({ requestId: ctx.requestId, endpoint: ctx.endpoint, profile: ctx.profile, stage, tag: 'map_after', data: out }); } catch { /* ignore */ }
    }
    try { await writeFilterSnapshot({ requestId: ctx.requestId, endpoint: ctx.endpoint, profile: ctx.profile, stage, tag: 'end', data: out }); } catch { /* ignore */ }
    return out;
  }

  private applyFieldMap(input: JsonObject, rules: FieldMapRule[]): JsonObject {
    if (!rules?.length) return input;
    const clone = this.deepClone(input);
    for (const r of rules) {
      // In-place wildcard support when sourcePath===targetPath and contains [*]
      if (r.sourcePath === r.targetPath && /\[\*\]/.test(r.sourcePath)) {
        this.mutateWildcardPath(clone, r.sourcePath, (val: unknown) => {
          const v1 = (r.transform && this.transforms[r.transform]) ? this.transforms[r.transform](val) : val;
          return this.coerce(v1, r.type);
        });
        continue;
      }
      const srcVals = this.getByPath(clone, r.sourcePath);
      if (srcVals.length === 0) continue;
      const v0 = srcVals[0];
      const v1 = (r.transform && this.transforms[r.transform]) ? this.transforms[r.transform](v0) : v0;
      const v2 = this.coerce(v1, r.type);
      this.setByPath(clone, r.targetPath, v2);
    }
    return clone;
  }

  private coerce(v: unknown, t?: FieldMapRule['type']): unknown {
    if (!t) return v;
    try {
      switch (t) {
        case 'string': return (typeof v === 'string') ? v : JSON.stringify(v ?? '');
        case 'number': return (typeof v === 'number') ? v : Number(v);
        case 'boolean': return (typeof v === 'boolean') ? v : Boolean(v);
        case 'object': return (v && typeof v === 'object') ? v : {};
        case 'array': return Array.isArray(v) ? v : (v == null ? [] : [v]);
        default: return v;
      }
    } catch { return v; }
  }

  private deepClone<T>(o: T): T { return JSON.parse(JSON.stringify(o)) as T; }

  private mutateWildcardPath(obj: unknown, path: string, fn: (v: unknown) => unknown): void {
    const segs = path.split('.').map(s => s.trim()).filter(Boolean);
    const recur = (node: any, idx: number): void => {
      if (idx >= segs.length) return;
      const seg = segs[idx];
      const m = seg.match(/^(\w+)(\[\*\])?$/);
      if (!m) return;
      const key = m[1];
      const star = !!m[2];
      if (!node || typeof node !== 'object' || !(key in node)) return;
      const next = (node as any)[key];
      if (!star) {
        if (idx === segs.length - 1) {
          (node as any)[key] = fn(next);
        } else {
          recur(next, idx + 1);
        }
        return;
      }
      // star: array expected
      if (Array.isArray(next)) {
        if (idx === segs.length - 1) {
          for (let i = 0; i < next.length; i++) { next[i] = fn(next[i]); }
        } else {
          for (const item of next) { recur(item, idx + 1); }
        }
      }
    };
    recur(obj, 0);
  }

  // Minimal dot-path getter (no array wildcards). Returns array for symmetry with potential multi-matches later.
  private getByPath(obj: unknown, path: string): unknown[] {
    try {
      if (!obj || typeof obj !== 'object') return [];
      const parts = path.split('.').map(s => s.trim()).filter(Boolean);
      let cur: any = obj;
      for (const p of parts) { if (cur && typeof cur === 'object' && p in cur) cur = cur[p]; else return []; }
      return [cur];
    } catch { return []; }
  }

  private setByPath(obj: unknown, path: string, value: unknown): void {
    try {
      if (!obj || typeof obj !== 'object') return;
      const parts = path.split('.').map(s => s.trim()).filter(Boolean);
      let cur: any = obj;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (i === parts.length - 1) { cur[p] = value; break; }
        if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
        cur = cur[p];
      }
    } catch { /* ignore */ }
  }
}
