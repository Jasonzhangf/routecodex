import { injectMcpToolsForChat } from '../mcp-injection.js';
import {
  normalizeOpenaiChatMessagesWithNative,
  normalizeOpenaiMessageWithNative,
  normalizeOpenaiToolCallWithNative,
  normalizeOpenaiToolWithNative
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';
import { enforceChatBudgetWithNative } from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

// Message normalization utilities for OpenAI chat payloads (renamed to avoid confusion
// with the deprecated "openai-normalizer" module entry). This file contains the
// previously-implemented logic from openai-normalize.ts.

// Legacy tooling stage removed for Chat; tool canonicalization lives in codecs

export function normalizeChatRequest(request: any): any {
  if (!request || typeof request !== 'object') return request;
  let normalized = { ...request };

  if (Array.isArray(normalized.messages)) {
    normalized.messages = normalized.messages.map((msg: any) => normalizeMessage(msg));
  }

  if (Array.isArray(normalized.tools)) {
    normalized.tools = normalized.tools.map((tool: any) => normalizeTool(tool));
  }

  // Assistant text limit handling has been moved into native budget enforcement.

  // MCP 注入（两步法）统一走共享实现，避免路径分叉
  const disableMcpTools = Boolean((normalized as any).__rcc_disable_mcp_tools);
  if (!disableMcpTools) {
    try {
      const enableMcp = String((process as any)?.env?.ROUTECODEX_MCP_ENABLE ?? '1') !== '0';
      if (enableMcp) {
        const known = new Set<string>();
        const fromEnv = String((process as any)?.env?.RCC_MCP_SERVERS || '').trim();
        if (fromEnv) {
          for (const s of fromEnv.split(',').map((x: string) => x.trim()).filter(Boolean)) known.add(s);
        }

        const addServer = (v: unknown) => {
          if (typeof v === 'string') {
            const s = v.trim();
            if (s) known.add(s);
          }
        };
        const extractFromOutput = (output: unknown) => {
          try {
            if (Array.isArray(output)) {
              for (const item of output) {
                if (typeof item === 'string') addServer(item);
                else if (item && typeof item === 'object' && !Array.isArray(item)) addServer((item as any).server);
              }
              return;
            }
            if (!output || typeof output !== 'object' || Array.isArray(output)) return;
            const o: any = output;
            if (Array.isArray(o.servers)) for (const s of o.servers) addServer(s);
            if (Array.isArray(o.resources)) for (const r of o.resources) addServer(r?.server ?? r?.source?.server);
            if (Array.isArray(o.resourceTemplates)) for (const t of o.resourceTemplates) addServer(t?.server ?? t?.source?.server);
          } catch {
            // best-effort
          }
        };

        // IMPORTANT: do NOT treat assistant tool_calls as authoritative for MCP server labels
        // (the model may guess "shell"/"exec_command"/etc). Only trust tool results.
        try {
          const msgs = Array.isArray((normalized as any).messages) ? ((normalized as any).messages as any[]) : [];
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            if (String((m as any).role || '').toLowerCase() !== 'tool') continue;
            const content = (m as any).content;
            if (typeof content !== 'string' || content.trim().length === 0) continue;
            try {
              const parsed: any = JSON.parse(content);
              if (parsed && typeof parsed === 'object' && parsed.version === 'rcc.tool.v1' && parsed.tool?.name) {
                const toolName = String(parsed.tool.name).toLowerCase();
                if (toolName === 'list_mcp_resources') {
                  extractFromOutput(parsed.result?.output);
                }
              } else {
                extractFromOutput(parsed?.output ?? parsed);
              }
            } catch {
              // ignore
            }
          }
        } catch { /* ignore */ }

        const discovered = Array.from(known);
        const currentTools: any[] = Array.isArray((normalized as any).tools) ? ((normalized as any).tools as any[]) : [];
        (normalized as any).tools = injectMcpToolsForChat(currentTools, discovered);
      }
    } catch { /* ignore MCP injection */ }
  }

  // 工具消息文本化 + 最后一轮 call 结果一致化 + 空 assistant 回合清理（native）
  try {
    const msgs: any[] = Array.isArray((normalized as any).messages) ? ((normalized as any).messages as any[]) : [];
    if (msgs.length) {
      (normalized as any).messages = normalizeOpenaiChatMessagesWithNative(msgs);
    }
  } catch { /* ignore message normalization */ }

  // 注意：不合并/删除多条 system（与 统一标准，避免高风险修改）。

  // 基于“载荷预算”（配置驱动）进行裁剪，统一走 native。
  try {
    const msgs: any[] = Array.isArray((normalized as any).messages) ? ((normalized as any).messages as any[]) : [];
    if (msgs.length) {
      const modelId = String((normalized as any)?.model || '').trim();
      const budget = resolveBudgetForModelSync(modelId);
      const allowed = Math.max(32 * 1024, Math.floor(budget.allowedBytes));
      const sysLimit = (() => {
        const raw = (process as any)?.env?.RCC_SYSTEM_TEXT_LIMIT; const n = Number(raw);
        return Number.isFinite(n) && n >= 0 ? n : 8192;
      })();
      normalized = enforceChatBudgetWithNative(normalized, allowed, sysLimit) as any;
    }
  } catch { /* ignore budget enforcement */ }

  // Do not invoke legacy tooling stage here; codecs perform canonicalization
  return normalized;
}

function normalizeChatResponse(res: any): any {
  // Deprecated: pass-through. Tool canonicalization and reasoning handling are done in codecs/compat layers.
  return res;
  if (false) {
    // legacy kept for reference
  }
}

function normalizeMessage(message: any): any {
  const disableShellCoerce = String(process?.env?.RCC_DISABLE_SHELL_COERCE ?? process?.env?.ROUTECODEX_DISABLE_SHELL_COERCE ?? '').toLowerCase();
  const isDisabled = disableShellCoerce === '1' || disableShellCoerce === 'true';
  return normalizeOpenaiMessageWithNative(message, isDisabled);
}

function normalizeTool(tool: any): any {
  return normalizeOpenaiToolWithNative(tool);
}

function normalizeToolCall(tc: any): any {
  const disableShellCoerce = String(process?.env?.RCC_DISABLE_SHELL_COERCE ?? process?.env?.ROUTECODEX_DISABLE_SHELL_COERCE ?? '').toLowerCase();
  const isDisabled = disableShellCoerce === '1' || disableShellCoerce === 'true';
  return normalizeOpenaiToolCallWithNative(tc, isDisabled);
}

import { resolveBudgetForModelSync } from '../payload-budget.js';
