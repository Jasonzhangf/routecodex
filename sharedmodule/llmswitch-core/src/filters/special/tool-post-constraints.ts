import type { Filter, FilterContext, FilterResult, JsonObject } from '../types.js';

type ConstraintMatchCondition = 'missing' | 'empty' | 'missingOrEmpty';

interface ToolConstraintRule {
  id: string;
  direction: 'request' | 'response' | 'both';
  providerProtocol?: string;
  providerId?: string;
  modelId?: string;
  toolNamePattern?: string;
  path: string; // currently only supports tools[*].function.description 式简单路径
  when: ConstraintMatchCondition;
  action: 'warn' | 'patch' | 'drop';
  patchText?: string;
}

interface ToolGovernanceConstraintsConfig {
  rules: ToolConstraintRule[];
}

function matchesPattern(name: string, pattern?: string): boolean {
  if (!pattern) return true;
  if (!name) return false;
  // very small glob subset: '*' wildcard
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = new RegExp(`^${esc}$`, 'i');
  return re.test(name);
}

function getToolArray(root: any): any[] {
  const tools = (root && Array.isArray((root as any).tools)) ? (root as any).tools : [];
  return tools;
}

function checkCondition(v: unknown, cond: ConstraintMatchCondition): boolean {
  if (cond === 'missing') return v === undefined;
  if (cond === 'empty') return typeof v === 'string' && v.trim() === '';
  return v === undefined || (typeof v === 'string' && v.trim() === '');
}

/**
 * Tool post-constraints filter（请求/响应阶段的最后一小步约束）：
 * - 默认只记录（warn），不修改 payload；
 * - 修剪/修复行为完全由配置驱动（ToolGovernanceConstraintsConfig）；
 * - 当前仅实现缺失/空 description 的简单场景，后续可按配置扩展。
 */
export class ToolPostConstraintsFilter implements Filter<JsonObject> {
  readonly name = 'tool_post_constraints';
  readonly stage: FilterContext['stage'];
  private readonly config: ToolGovernanceConstraintsConfig;

  constructor(stage: FilterContext['stage'], config?: ToolGovernanceConstraintsConfig) {
    this.stage = stage;
    if (config) {
      this.config = config;
      return;
    }
    const defaultRules: ToolConstraintRule[] = [];
    // 默认行为：在请求侧最终阶段（request_finalize）修复缺失/空 description 的工具，
    // 避免因为 description 不合规导致整组工具被清空。
    if (stage === 'request_finalize') {
      defaultRules.push({
        id: 'patch_missing_tool_description',
        direction: 'request',
        path: 'tools[*].function.description',
        when: 'missingOrEmpty',
        action: 'patch',
        patchText: 'Auto-generated description for ${toolName}'
      });
    }
    this.config = { rules: defaultRules };
  }

  apply(input: JsonObject, ctx: FilterContext): FilterResult<JsonObject> {
    try {
      if (!this.config.rules || !this.config.rules.length) {
        return { ok: true, data: input };
      }
      const out = JSON.parse(JSON.stringify(input || {}));
      const direction: 'request' | 'response' =
        (typeof ctx.stage === 'string' && ctx.stage.startsWith('request_')) ? 'request' : 'response';

      const providerProtocol = ctx.profile || '';
      const providerId = (ctx as any).providerId || '';
      const modelId = (ctx as any).modelId || '';

      const tools = getToolArray(out);
      if (!tools.length) {
        return { ok: true, data: out };
      }

      const issues: Array<{ ruleId: string; toolName?: string; action: string }> = [];

      for (const rule of this.config.rules) {
        if (rule.direction !== 'both' && rule.direction !== direction) continue;
        if (rule.providerProtocol && rule.providerProtocol !== providerProtocol) continue;
        if (rule.providerId && rule.providerId !== providerId) continue;
        if (rule.modelId && rule.modelId !== modelId) continue;

        // 当前仅支持 tools[*].function.description 这一类路径
        if (rule.path !== 'tools[*].function.description') continue;

        for (let i = 0; i < tools.length; i++) {
          const t = tools[i];
          if (!t || typeof t !== 'object') continue;
          const fn = (t as any).function;
          const name = typeof fn?.name === 'string' ? fn.name : '';
          if (!matchesPattern(name, rule.toolNamePattern)) continue;

          const desc = fn?.description;
          if (!checkCondition(desc, rule.when)) continue;

          if (rule.action === 'patch' && rule.patchText) {
            (fn as any).description = rule.patchText.replace('${toolName}', name || 'tool');
          } else if (rule.action === 'drop') {
            tools.splice(i, 1);
            i--;
          }
          issues.push({ ruleId: rule.id, toolName: name, action: rule.action });
        }
      }

      if (issues.length && (ctx as any)?.logger && typeof (ctx as any).logger.log === 'function') {
        try {
          (ctx as any).logger.log('tool-post-constraints', {
            requestId: ctx.requestId,
            endpoint: ctx.endpoint,
            profile: ctx.profile,
            issues
          });
        } catch {
          // ignore logging failures
        }
      }

      return { ok: true, data: out };
    } catch {
      return { ok: true, data: input };
    }
  }
}
