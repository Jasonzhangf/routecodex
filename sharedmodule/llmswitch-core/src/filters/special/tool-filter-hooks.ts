import type {
  Filter,
  FilterContext,
  FilterResult,
  JsonObject,
  ToolFilterDecision,
  ToolFilterHints,
} from '../types.js';

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

interface ToolFilterConfigCategoryPolicy {
  mode?: 'allow' | 'block' | 'require_content';
  requireContentTypes?: string[];
}

interface ToolFilterConfig {
  categories?: {
    vision?: ToolFilterConfigCategoryPolicy;
    mcp?: ToolFilterConfigCategoryPolicy;
  };
}

interface ToolFilterHookContext {
  tools: any[];
  messages: any[];
  hints: ToolFilterHints;
  config: ToolFilterConfig;
  stage: 'request' | 'response';
  recordDecision(decision: ToolFilterDecision): void;
}

type ToolFilterHook = (ctx: ToolFilterHookContext) => void | Promise<void>;

// Global (process-level) config – expected to be filled by host via setGlobalToolFilterConfig。
// 默认空配置：不改变行为，仅当 hints/配置显式要求时才执行过滤。
let globalConfig: ToolFilterConfig = {};

export function setGlobalToolFilterConfig(cfg: ToolFilterConfig | undefined): void {
  if (!cfg || !isObject(cfg)) {
    globalConfig = {};
    return;
  }
  globalConfig = clone(cfg as ToolFilterConfig);
}

export function getGlobalToolFilterConfig(): ToolFilterConfig {
  return globalConfig;
}

// --- Vision 工具 Hook：仅在 hints/categoryOverrides 明确要求时启用 ---

function hasImageContent(messages: any[]): boolean {
  try {
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      const c = (m as any).content;
      if (Array.isArray(c)) {
        for (const part of c) {
          if (part && typeof part === 'object') {
            const t = String((part as any).type || '').toLowerCase();
            if (t.includes('image')) return true;
          }
        }
      }
    }
  } catch {
    // non-fatal
  }
  return false;
}

function isVisionTool(tool: any): boolean {
  try {
    const name =
      tool &&
      typeof tool === 'object' &&
      (tool as any).function &&
      typeof (tool as any).function.name === 'string'
        ? String((tool as any).function.name).toLowerCase()
        : '';
    if (!name) return false;
    // 保守实现：仅将 view_image 视为视觉工具；其他名称可通过上层配置扩展。
    if (name === 'view_image') return true;
    if (name.includes('vision')) return true;
  } catch {
    // ignore
  }
  return false;
}

const visionToolHook: ToolFilterHook = ctx => {
  const { tools, messages, hints, config, recordDecision } = ctx;
  if (!tools.length) return;

  const hasVision = tools.some(t => isVisionTool(t));
  if (!hasVision) return;

  const override = hints.categoryOverrides?.vision;
  const cfgPolicy = config.categories?.vision?.mode;
  // 默认策略：require_content —— 有视觉工具但无图像内容时进行过滤提示
  const mode: 'allow' | 'block' | 'require_content' =
    (override as any) || (cfgPolicy as any) || 'require_content';

  if (mode === 'allow') return;

  const hasImage = hasImageContent(messages);
  const next: any[] = [];
  for (const t of tools) {
    if (isVisionTool(t)) {
        if (mode === 'block' || (mode === 'require_content' && !hasImage)) {
          const name =
            t &&
            typeof t === 'object' &&
            (t as any).function &&
          typeof (t as any).function.name === 'string'
            ? String((t as any).function.name)
            : 'unknown';
          recordDecision({
            name,
            action: 'block',
            category: 'vision',
            reason:
              mode === 'block'
                ? 'vision_tool_blocked_by_policy'
                : 'vision_tool_without_image_link',
          });
        continue;
      }
    }
    next.push(t);
  }

  ctx.tools = next;
};

// --- MCP 工具 Hook：会话内阶段性暴露策略 ---

function isMcpToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === 'list_mcp_resources' ||
    lower === 'read_mcp_resource' ||
    lower === 'list_mcp_resource_templates'
  );
}

function deriveMcpSessionState(messages: any[]): {
  listRequested: boolean;
  listEmpty: boolean;
} {
  let listRequested = false;
  let listEmpty = false;

  const extractToolContentText = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const p: any = part;
      if (typeof p.text === 'string' && p.text.trim().length) {
        parts.push(p.text);
      }
    }
    return parts.join('\n');
  };

  const markListEmptyFromPayload = (payload: any): void => {
    if (!payload || typeof payload !== 'object') return;
    const out = (payload as any).output ?? payload;
    if (!out || typeof out !== 'object') return;
    if (Array.isArray((out as any).resources) && (out as any).resources.length === 0) {
      listRequested = true;
      listEmpty = true;
    }
    if (Array.isArray((out as any).servers) && (out as any).servers.length === 0) {
      listRequested = true;
      listEmpty = true;
    }
    const err = (out as any).error ?? (payload as any).error;
    if (err && typeof err === 'object') {
      const code = (err as any).code;
      const msg = typeof (err as any).message === 'string' ? String((err as any).message).toLowerCase() : '';
      if (code === -32601 || msg.includes('method not found')) {
        listRequested = true;
        listEmpty = true;
      }
    }
  };

  try {
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      const role = String((m as any).role || '').toLowerCase();

      // assistant.tool_calls: 视为对 list_mcp_resources 的“请求”
      if (role === 'assistant' && Array.isArray((m as any).tool_calls)) {
        for (const tc of (m as any).tool_calls as any[]) {
          try {
            const fn = tc && (tc as any).function;
            const name =
              fn && typeof (fn as any).name === 'string'
                ? String((fn as any).name).toLowerCase()
                : '';
            if (name === 'list_mcp_resources') {
              listRequested = true;
            }
          } catch {
            /* ignore single tool_call */
          }
        }
      }

      // tool 角色消息：检查 rcc.tool.v1 包装的结果是否为空
      if (role === 'tool') {
        try {
          const rawText = extractToolContentText((m as any).content);
          if (!rawText || rawText.trim().length === 0) {
            continue;
          }
          const lowered = rawText.toLowerCase();
          if (lowered.includes('-32601') || (lowered.includes('method') && lowered.includes('not found'))) {
            listRequested = true;
            listEmpty = true;
          }
          const parsed = JSON.parse(rawText);
          if (
            parsed &&
            typeof parsed === 'object' &&
            parsed.version === 'rcc.tool.v1' &&
            parsed.tool &&
            typeof parsed.tool.name === 'string'
          ) {
            const nm = String(parsed.tool.name).toLowerCase();
            if (nm === 'list_mcp_resources') {
              listRequested = true;
              const out = parsed.result?.output;
              if (Array.isArray(out) && out.length === 0) {
                listEmpty = true;
              } else if (
                out &&
                typeof out === 'object' &&
                Array.isArray((out as any).resources) &&
                (out as any).resources.length === 0
              ) {
                listEmpty = true;
              }
            }
            continue;
          }
          // Non-wrapped tool output (common for Codex tool responses).
          // If the payload looks like list_mcp_resources output and is empty/unsupported, disable MCP tools for this session.
          markListEmptyFromPayload(parsed);
        } catch {
          // ignore parse errors
        }
      }
    }
  } catch {
    // ignore errors
  }

  return { listRequested, listEmpty };
}

const mcpToolHook: ToolFilterHook = ctx => {
  const { tools, messages, hints, recordDecision } = ctx;
  if (!tools.length) return;

  const mcpTools = tools.filter(t => {
    try {
      const n =
        t &&
        typeof t === 'object' &&
        (t as any).function &&
        typeof (t as any).function.name === 'string'
          ? String((t as any).function.name)
          : '';
      return isMcpToolName(n);
    } catch {
      return false;
    }
  });
  if (!mcpTools.length) return;

  const override = hints.categoryOverrides?.mcp;
  if (override === 'block') {
    // 请求级别完全关闭 MCP
    ctx.tools = tools.filter(t => !mcpTools.includes(t));
    for (const t of mcpTools) {
      const name =
        t &&
        typeof t === 'object' &&
        (t as any).function &&
        typeof (t as any).function.name === 'string'
          ? String((t as any).function.name)
          : 'unknown';
      recordDecision({
        name,
        action: 'block',
        category: 'mcp',
        reason: 'mcp_blocked_by_override',
      });
    }
    return;
  }

  // 会话内阶段性策略：
  // 1) 如果 list_mcp_resources 从未在本会话中被请求过 → 仅暴露 list_mcp_resources，过滤 read/templates。
  // 2) 如果 list_mcp_resources 已请求且结果为空 → 完全过滤所有 MCP 工具。
  const { listRequested, listEmpty } = deriveMcpSessionState(messages);

  const next: any[] = [];
  for (const t of tools) {
    let name = '';
    try {
      name =
        t &&
        typeof t === 'object' &&
        (t as any).function &&
        typeof (t as any).function.name === 'string'
          ? String((t as any).function.name)
          : '';
    } catch {
      name = '';
    }
    const lower = name.toLowerCase();
    const isMcp = isMcpToolName(name);

    if (!isMcp) {
      next.push(t);
      continue;
    }

    if (!listRequested) {
      // list 未被请求过：保留 list_mcp_resources，其它 MCP 工具全部过滤
      if (lower === 'list_mcp_resources') {
        next.push(t);
        recordDecision({
          name,
          action: 'allow',
          category: 'mcp',
          reason: 'mcp_list_exposed_before_first_use',
        });
      } else {
        recordDecision({
          name,
          action: 'block',
          category: 'mcp',
          reason: 'mcp_non_list_blocked_until_list_called',
        });
      }
      continue;
    }

    if (listEmpty) {
      // list 已请求且结果为空：完全屏蔽所有 MCP 工具
      recordDecision({
        name,
        action: 'block',
        category: 'mcp',
        reason: 'mcp_disabled_for_session_after_empty_list',
      });
      continue;
    }

    // list 已请求且非空：保留现有行为（交由其它层/配置控制）
    next.push(t);
  }

  ctx.tools = next;
};

const requestHooks: ToolFilterHook[] = [visionToolHook, mcpToolHook];

export class ToolFilterHookFilter implements Filter<JsonObject> {
  readonly name = 'tool_filter_hook';
  readonly stage: FilterContext['stage'] = 'request_finalize';

  apply(input: JsonObject, ctx: FilterContext): FilterResult<JsonObject> {
    try {
      const out = clone(input || {});
      const tools = Array.isArray((out as any).tools)
        ? ((out as any).tools as any[])
        : [];
      if (!tools.length) {
        return { ok: true, data: out };
      }

      const messages = Array.isArray((out as any).messages)
        ? ((out as any).messages as any[])
        : [];
      const hints: ToolFilterHints = (ctx.toolFilterHints && clone(ctx.toolFilterHints)) || {
        requestedDecisions: [],
      };
      const config = getGlobalToolFilterConfig();
      const decisions: ToolFilterDecision[] = [];

      const hookCtx: ToolFilterHookContext = {
        tools,
        messages,
        hints,
        config,
        stage: 'request',
        recordDecision: d => {
          decisions.push(d);
        },
      };

      for (const hook of requestHooks) {
        try {
          const res = hook(hookCtx);
          if (res && typeof (res as any).then === 'function') {
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            (res as Promise<void>).catch(() => {});
          }
        } catch {
          // ignore single hook failure
        }
      }

      (out as any).tools = hookCtx.tools;
      if (Array.isArray((out as any).tools) && (out as any).tools.length === 0) {
        try {
          if ('tool_choice' in (out as any)) delete (out as any).tool_choice;
        } catch {
          /* ignore */
        }
      }

      // 记录决策（供调试/快照使用）
      if (!Array.isArray(hints.decided)) hints.decided = [];
      hints.decided = hints.decided.concat(decisions);

      return {
        ok: true,
        data: out,
        metrics: decisions.length
          ? { toolFilterDecisions: clone(decisions) }
          : undefined,
      };
    } catch {
      return { ok: true, data: input };
    }
  }
}
