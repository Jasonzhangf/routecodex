import type { ToolMappingsConfig, ToolMapping } from '../../../config/tool-mapping-loader.js';

type ExtractResult = { calls: { name: string; args: Record<string, any> }[]; rest: string };

export class ToolMappingExecutor {
  constructor(private readonly config: ToolMappingsConfig) {}

  apply(content: string): ExtractResult {
    let rest = content || '';
    const calls: { name: string; args: Record<string, any> }[] = [];

    if (!this.config?.tools) return { calls, rest };

    // Iterate each tool config and try patterns
    for (const [toolName, mapping] of Object.entries(this.config.tools)) {
      const out = this.applyTool(toolName, mapping, rest);
      if (out.calls.length) {
        // Append and update remaining text
        calls.push(...out.calls);
        rest = out.rest;
        const maxCalls = this.config?.global?.max_tool_calls ?? Infinity;
        if (calls.length >= maxCalls) break;
      }
    }

    return { calls, rest };
  }

  private applyTool(tool: string, mapping: ToolMapping, text: string): ExtractResult {
    let rest = text;
    const calls: { name: string; args: Record<string, any> }[] = [];

    const patterns = mapping.patterns || [];
    for (const p of patterns) {
      // Minimal implementation: bracket+regex patterns to capture malformed JSON
      if (p.type === 'bracket' && p.regex) {
        const re = new RegExp(p.regex, 'gi');
        let m: RegExpExecArray | null;
        while ((m = re.exec(rest)) !== null) {
          const args = this.buildArgsFromMapping(p.fields || {}, m.groups || {});
          const aliasArgs = this.applyAliases(args, mapping.aliases || {});
          const finalArgs = this.postprocess(aliasArgs, mapping.postprocess || []);
          calls.push({ name: tool, args: finalArgs });
          // remove match from rest
          rest = (rest.slice(0, m.index) + rest.slice(m.index + m[0].length)).trim();
          re.lastIndex = 0; // reset due to mutation
          const maxCalls = this.config?.global?.max_tool_calls ?? Infinity;
          if (calls.length >= maxCalls) break;
        }
      }
      if (calls.length >= (this.config?.global?.max_tool_calls ?? Infinity)) break;
    }

    return { calls, rest };
  }

  private buildArgsFromMapping(template: Record<string, any>, groups: Record<string, any>): Record<string, any> {
    const res: Record<string, any> = {};
    for (const [k, v] of Object.entries(template)) {
      res[k] = this.interpolate(v, groups);
    }
    return res;
  }

  private interpolate(value: any, vars: Record<string, any>): any {
    if (typeof value === 'string') {
      return value.replace(/\$\{([^}]+)\}/g, (_m, key) => String(vars[key] ?? ''));
    }
    if (Array.isArray(value)) {
      return value.map(v => this.interpolate(v, vars));
    }
    if (value && typeof value === 'object') {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.interpolate(v as any, vars);
      return out;
    }
    return value;
  }

  private applyAliases(args: Record<string, any>, aliases: Record<string, string>): Record<string, any> {
    const out: Record<string, any> = { ...args };
    for (const [from, to] of Object.entries(aliases || {})) {
      if (from in out && !(to in out)) {
        out[to] = out[from];
        delete out[from];
      }
    }
    return out;
  }

  private postprocess(args: Record<string, any>, steps: ToolMapping['postprocess']): Record<string, any> {
    let out = { ...args };
    for (const step of steps || []) {
      if ('ensure_array' in step) {
        const field = step.ensure_array.field;
        const v = out[field];
        if (Array.isArray(v)) {
          out[field] = v.map(String);
        } else if (typeof v === 'string') {
          out[field] = step.ensure_array.default_shell ? ['bash', '-lc', v] : [v];
        } else if (v == null && step.ensure_array.default_shell) {
          out[field] = ['bash', '-lc', ''];
        }
      } else if ('wrap_object' in step) {
        const field = step.wrap_object.field;
        const v = out[field];
        if (typeof v === 'string') {
          out[field] = v;
        }
      }
    }
    return out;
  }
}

