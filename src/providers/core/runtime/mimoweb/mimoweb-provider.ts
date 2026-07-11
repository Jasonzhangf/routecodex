/**
 * MiMo Web Provider
 *
 * Anthropic-protocol provider that talks to MiMo Web (aistudio.xiaomimimo.com).
 * Text-based tool guidance on send; text-based tool-call harvest on receive.
 * All logic stays within this module — no Hub Pipeline leakage.
 */

import { createHash } from "node:crypto";
import { BaseProvider } from "../base-provider.js";
import type { UnknownObject } from "../../../../types/common-types.js";
import type { ModuleDependencies } from "../../../../modules/pipeline/interfaces/pipeline-interfaces.js";
import type { OpenAIStandardConfig } from "../../api/provider-config.js";
import type { ProviderContext, ServiceProfile } from "../../api/provider-types.js";
import type { IAuthProvider, AuthStatus } from "../../../auth/auth-interface.js";
import type { MimoCookieAuth } from "./mimoweb-types.js";
import { resolveModelId, callMimoWeb } from "./mimoweb-client.js";
import { normalizeAnthropicToolDef, type AnthropicToolDef } from "./mimoweb-tool-guidance.js";
import { serializeMessages } from "./mimoweb-serialize.js";
import { normalizeAssistantTextToToolCallsJson } from "../../../../modules/llmswitch/bridge/mimoweb-tool-harvest-host.js";
import { extractProviderRuntimeMetadata } from "../provider-runtime-metadata.js";

type ContentBlock = {
  type: string;
  text?: string;
  tool_use_id?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
  content?: string | ContentBlock[];
};

type OpenAIToolCall = {
  id?: string;
  tool_call_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type Msg = {
  role: "user" | "assistant" | "system" | "tool";
  content?: string | ContentBlock[];
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
};

type ToolCallLike = {
  name: string;
  input: Record<string, unknown>;
};

type MimowebRequestDiagnostics = {
  requestId?: string;
  routeName?: string;
  sessionId?: string;
  conversationId?: string;
  model: string;
  resolvedModel: string;
  messageCount: number;
  userCount: number;
  assistantCount: number;
  toolCount: number;
  openAiAssistantToolCallCount: number;
  anthropicToolUseCount: number;
  anthropicToolResultCount: number;
  toolDefinitionCount: number;
  queryLength: number;
  systemPromptLength: number;
  queryPreviewHead: string;
  queryPreviewTail: string;
};

function stripNulBytes(value: string): string {
  if (!value) {
    return '';
  }
  return value.replace(/\u0000/g, '');
}

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function previewHead(text: string, max = 240): string {
  if (!text) {
    return '';
  }
  return text.length <= max ? text : text.slice(0, max);
}

function previewTail(text: string, max = 240): string {
  if (!text) {
    return '';
  }
  return text.length <= max ? text : text.slice(-max);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map((entry) => stableStringify(entry)).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return '{' + Object.keys(row).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(row[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function buildToolSignature(call: ToolCallLike): string {
  return `${call.name}::${stableStringify(call.input ?? {})}`;
}

function extractImmediateMatchedToolRound(messages: Msg[]): string[] {
  for (let userIndex = messages.length - 1; userIndex >= 0; userIndex -= 1) {
    const userMsg = messages[userIndex];
    const matchedIds = new Set<string>();
    if (userMsg?.role === 'tool') {
      if (typeof userMsg.tool_call_id === 'string' && userMsg.tool_call_id.trim()) {
        matchedIds.add(userMsg.tool_call_id.trim());
      }
    } else if (userMsg?.role === 'user' && Array.isArray(userMsg.content)) {
      const toolResults = userMsg.content.filter((block) => block?.type === 'tool_result');
      for (const block of toolResults) {
        if (typeof block.tool_use_id === 'string' && block.tool_use_id.trim()) {
          matchedIds.add(block.tool_use_id.trim());
        }
      }
    } else {
      continue;
    }
    if (matchedIds.size === 0) {
      return [];
    }
    for (let assistantIndex = userIndex - 1; assistantIndex >= 0; assistantIndex -= 1) {
      const assistantMsg = messages[assistantIndex];
      if (assistantMsg?.role !== 'assistant') {
        continue;
      }
      const anthropicToolUses = Array.isArray(assistantMsg.content)
        ? assistantMsg.content
          .filter((block) => block?.type === 'tool_use')
          .filter((block) => typeof block.id === 'string' && matchedIds.has(block.id.trim()))
          .map((block) => buildToolSignature({
            name: block.name ?? '',
            input: block.input ?? {},
          }))
        : [];
      const openAiToolUses = Array.isArray(assistantMsg.tool_calls)
        ? assistantMsg.tool_calls
          .filter((call) => {
            const id =
              (typeof call.id === 'string' && call.id.trim())
              || (typeof call.tool_call_id === 'string' && call.tool_call_id.trim())
              || (typeof call.call_id === 'string' && call.call_id.trim())
              || '';
            return Boolean(id && matchedIds.has(id));
          })
          .map((call) => {
            const name =
              (typeof call.function?.name === 'string' && call.function.name.trim())
              || (typeof call.name === 'string' && call.name.trim())
              || '';
            const rawArgs =
              (typeof call.function?.arguments === 'string' && call.function.arguments.trim())
              || (typeof call.arguments === 'string' && call.arguments.trim())
              || '{}';
            let input: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(rawArgs);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                input = parsed as Record<string, unknown>;
              }
            } catch {
              input = {};
            }
            return buildToolSignature({ name, input });
          })
        : [];
      const matchedToolUses = [...anthropicToolUses, ...openAiToolUses]
        .filter((value) => value.length > 2);
      return matchedToolUses;
    }
    return [];
  }
  return [];
}

function buildStableConversationId(request: UnknownObject): string {
  const runtimeMetadata = extractProviderRuntimeMetadata(request);
  const metadata =
    runtimeMetadata?.metadata && typeof runtimeMetadata.metadata === 'object'
      ? runtimeMetadata.metadata as Record<string, unknown>
      : undefined;
  const sessionId =
    readNonEmptyString(metadata?.sessionId)
    || readNonEmptyString(runtimeMetadata?.sessionId);
  const conversationId =
    readNonEmptyString(metadata?.conversationId)
    || readNonEmptyString(runtimeMetadata?.conversationId);
  const sessionSeed =
    conversationId
    || sessionId
    || readNonEmptyString(runtimeMetadata?.requestId)
    || '';
  if (!sessionSeed) {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  }
  return createHash('sha256')
    .update(`mimoweb:${sessionSeed}`)
    .digest('hex')
    .slice(0, 32);
}

function countDiagnostics(messages: Msg[]): {
  userCount: number;
  assistantCount: number;
  toolCount: number;
  openAiAssistantToolCallCount: number;
  anthropicToolUseCount: number;
  anthropicToolResultCount: number;
} {
  let userCount = 0;
  let assistantCount = 0;
  let toolCount = 0;
  let openAiAssistantToolCallCount = 0;
  let anthropicToolUseCount = 0;
  let anthropicToolResultCount = 0;
  for (const message of messages) {
    if (message.role === 'user') userCount += 1;
    if (message.role === 'assistant') assistantCount += 1;
    if (message.role === 'tool') toolCount += 1;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      openAiAssistantToolCallCount += message.tool_calls.length;
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === 'tool_use') anthropicToolUseCount += 1;
        if (block?.type === 'tool_result') anthropicToolResultCount += 1;
      }
    }
  }
  return {
    userCount,
    assistantCount,
    toolCount,
    openAiAssistantToolCallCount,
    anthropicToolUseCount,
    anthropicToolResultCount,
  };
}

function buildRequestDiagnostics(args: {
  request: UnknownObject;
  messages: Msg[];
  tools: AnthropicToolDef[];
  model: string;
  resolvedModel: string;
  query: string;
  systemPrompt: string;
  conversationId: string;
}): MimowebRequestDiagnostics {
  const runtimeMetadata = extractProviderRuntimeMetadata(args.request);
  const metadata =
    runtimeMetadata?.metadata && typeof runtimeMetadata.metadata === 'object'
      ? runtimeMetadata.metadata as Record<string, unknown>
      : undefined;
  const counts = countDiagnostics(args.messages);
  const sessionId =
    readNonEmptyString(metadata?.sessionId)
    || readNonEmptyString(runtimeMetadata?.sessionId);
  return {
    requestId: readNonEmptyString(runtimeMetadata?.requestId) || undefined,
    routeName: readNonEmptyString(runtimeMetadata?.routeName) || undefined,
    sessionId: sessionId || undefined,
    conversationId: args.conversationId,
    model: args.model,
    resolvedModel: args.resolvedModel,
    messageCount: args.messages.length,
    userCount: counts.userCount,
    assistantCount: counts.assistantCount,
    toolCount: counts.toolCount,
    openAiAssistantToolCallCount: counts.openAiAssistantToolCallCount,
    anthropicToolUseCount: counts.anthropicToolUseCount,
    anthropicToolResultCount: counts.anthropicToolResultCount,
    toolDefinitionCount: args.tools.length,
    queryLength: args.query.length,
    systemPromptLength: args.systemPrompt.length,
    queryPreviewHead: previewHead(args.query),
    queryPreviewTail: previewTail(args.query),
  };
}

function formatDiagnosticsReason(
  prefix: string,
  diagnostics: MimowebRequestDiagnostics,
  extras?: Record<string, unknown>,
): string {
  const parts: string[] = [];
  const routeName = diagnostics.routeName ?? 'unknown';
  const sessionId = diagnostics.sessionId ?? 'unknown';
  parts.push(`route=${routeName}`);
  parts.push(`sessionId=${sessionId}`);
  parts.push(`queryLength=${diagnostics.queryLength}`);
  parts.push(`messageCount=${diagnostics.messageCount}`);
  parts.push(`assistantToolCalls=${diagnostics.openAiAssistantToolCallCount}`);
  parts.push(`toolDefinitions=${diagnostics.toolDefinitionCount}`);
  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      parts.push(`${key}=${String(value)}`);
    }
  }
  return `${prefix} (${parts.join(' ')})`;
}

function stripLegacyToolCallMarkup(text: string): string {
  if (!text || typeof text !== "string") {
    return "";
  }
  const patterns = [
    /<tool_?call(?:\s[^>]*)?>[\s\S]*?<\/tool_?call>/gi,
    /<function_calls?>[\s\S]*?<\/function_calls?>/gi,
    /<invoke(?:\s[^>]*)?>[\s\S]*?<\/invoke>/gi,
  ];
  let stripped = text;
  for (const pattern of patterns) {
    stripped = stripped.replace(pattern, " ");
  }
  return stripped.trim();
}

class MimowebInlineAuthProvider implements IAuthProvider {
  public readonly type = "apikey" as const;

  async initialize(): Promise<void> {}

  buildHeaders(): Record<string, string> {
    return {};
  }

  async validateCredentials(): Promise<boolean> {
    return true;
  }

  async cleanup(): Promise<void> {}

  getStatus(): AuthStatus {
    return {
      isAuthenticated: true,
      isValid: true,
      lastValidated: Date.now(),
    };
  }
}

export class MimowebProvider extends BaseProvider {
  public readonly type = "mimoweb";
  private auth: MimoCookieAuth | null = null;

  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    super(config, dependencies);
  }

  protected override async onInitialize(): Promise<void> {
    const cfg = this.config.config as Record<string, unknown>;
    const authCfg = (cfg.auth ?? {}) as Record<string, unknown>;

    // apiKey may be a JSON string: {"serviceToken":"...","userId":"...","phToken":"..."}
    let serviceToken = "";
    let userId = "";
    let phToken = "";

    const apiKeyRaw = typeof authCfg.apiKey === "string" ? authCfg.apiKey : "";
    if (apiKeyRaw.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(apiKeyRaw);
        serviceToken = parsed.serviceToken ?? "";
        userId = parsed.userId ?? "";
        phToken = parsed.phToken ?? "";
      } catch { /* not JSON, ignore */ }
    }

    // Fallback: direct fields on auth config
    if (!serviceToken) serviceToken = typeof authCfg.serviceToken === "string" ? authCfg.serviceToken : "";
    if (!userId) userId = typeof authCfg.userId === "string" ? authCfg.userId : "";
    if (!phToken) phToken = typeof authCfg.phToken === "string" ? authCfg.phToken : "";

    if (!serviceToken || !userId || !phToken) {
      throw new Error("MimowebProvider requires auth credentials (serviceToken, userId, phToken) either in apiKey as JSON or as direct auth fields");
    }
    this.auth = { serviceToken, userId, phToken };
  }

  protected getServiceProfile(): ServiceProfile {
    const cfg = this.config.config as Record<string, unknown>;
    const baseUrl =
      typeof cfg.baseUrl === "string" && cfg.baseUrl.trim()
        ? cfg.baseUrl.trim()
        : "https://aistudio.xiaomimimo.com";
    const endpoint =
      typeof cfg.endpoint === "string" && cfg.endpoint.trim()
        ? cfg.endpoint.trim()
        : `${baseUrl}/api/chat`;
    const defaultModel =
      typeof cfg.defaultModel === "string" && cfg.defaultModel.trim()
        ? cfg.defaultModel.trim()
        : "mimo-v2.5-pro";

    return {
      defaultBaseUrl: baseUrl,
      defaultEndpoint: endpoint,
      defaultModel,
      requiredAuth: ["serviceToken", "userId", "phToken"],
      optionalAuth: [],
      features: {
        customErrorParsing: true,
        customTimeout: true,
      },
    };
  }

  protected createAuthProvider(): IAuthProvider {
    return new MimowebInlineAuthProvider();
  }

  protected preprocessRequest(request: UnknownObject): UnknownObject {
    return request;
  }

  protected postprocessResponse(response: unknown, _context: ProviderContext): UnknownObject {
    return response as UnknownObject;
  }

  protected async sendRequestInternal(request: UnknownObject): Promise<UnknownObject> {
    if (!this.auth) throw new Error("MimowebProvider not initialized");

    const messages = (request.messages ?? []) as Msg[];
    const tools = Array.isArray(request.tools)
      ? (request.tools as unknown[])
        .map((entry) => normalizeAnthropicToolDef(entry as AnthropicToolDef))
        .filter((entry): entry is AnthropicToolDef => entry !== null)
      : [];
    const model = (typeof request.model === "string" ? request.model : "") || "mimo-v2.5-pro";
    const enableThinking = Boolean((request as Record<string, unknown>).thinking);

    const { query, systemPrompt } = serializeMessages(messages, tools);
    const fullQuery = systemPrompt ? `${systemPrompt}\n\n${query}` : query;
    const resolvedModel = await resolveModelId(model);
    const conversationId = buildStableConversationId(request);
    const diagnostics = buildRequestDiagnostics({
      request,
      messages,
      tools,
      model,
      resolvedModel,
      query,
      systemPrompt,
      conversationId,
    });

    let fullText = "";
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number; reasoningTokens: number } | null = null;

    for await (const chunk of callMimoWeb(this.auth, conversationId, fullQuery, enableThinking, resolvedModel)) {
      if (chunk.type === "text" && chunk.content) fullText += chunk.content;
      else if (chunk.type === "usage" && chunk.usage) usage = chunk.usage;
    }

    const normalizedMessage = await normalizeAssistantTextToToolCallsJson({
      role: "assistant",
      content: fullText
    });
    const harvested = this.extractHarvestedToolCalls(normalizedMessage);
    const hasStructuredToolMarker = this.hasStructuredToolMarker(fullText);
    const normalizedText = stripNulBytes(
      typeof normalizedMessage.content === 'string' ? normalizedMessage.content : '',
    );

    if (!fullText.trim() && harvested.length === 0) {
      this.dependencies.logger?.logModule('mimoweb-diagnostics', 'empty-upstream', {
        ...diagnostics,
        fullTextLength: fullText.length,
        normalizedTextLength: normalizedText.length,
        harvestedCount: harvested.length,
        hasStructuredToolMarker,
      });
      throw new Error(
        formatDiagnosticsReason(
          '[mimoweb] upstream assistant response was empty',
          diagnostics,
          {
            fullTextLength: fullText.length,
            normalizedTextLength: normalizedText.length,
            harvestedCount: harvested.length,
          },
        ),
      );
    }
    if (hasStructuredToolMarker && harvested.length === 0) {
      this.dependencies.logger?.logModule('mimoweb-diagnostics', 'tool-harvest-empty', {
        ...diagnostics,
        fullTextLength: fullText.length,
        normalizedTextLength: normalizedText.length,
        normalizedTextPreviewHead: previewHead(normalizedText),
        normalizedTextPreviewTail: previewTail(normalizedText),
        fullTextPreviewHead: previewHead(fullText),
        fullTextPreviewTail: previewTail(fullText),
        harvestedCount: harvested.length,
        hasStructuredToolMarker,
      });
      throw new Error(
        formatDiagnosticsReason(
          '[mimoweb] upstream emitted tool markers but no tool calls could be harvested',
          diagnostics,
          {
            fullTextLength: fullText.length,
            normalizedTextLength: normalizedText.length,
            hasStructuredToolMarker,
          },
        ),
      );
    }
    if (this.isImmediateRepeatedToolRound(messages, harvested)) {
      this.dependencies.logger?.logModule('mimoweb-diagnostics', 'repeated-tool-round', {
        ...diagnostics,
        harvestedCount: harvested.length,
        harvestedNames: harvested.map((entry) => entry.name),
        fullTextLength: fullText.length,
        normalizedTextLength: normalizedText.length,
        fullTextPreviewHead: previewHead(fullText),
        fullTextPreviewTail: previewTail(fullText),
      });
      throw new Error(
        formatDiagnosticsReason(
          '[mimoweb] upstream repeated prior tool call after tool_result',
          diagnostics,
          {
            harvestedCount: harvested.length,
          },
        ),
      );
    }
    const content: ContentBlock[] = [];

    // Extract text outside tool_call tags
    const textOnly =
      typeof normalizedMessage.content === "string" && normalizedMessage.content.trim()
        ? stripNulBytes(normalizedMessage.content).trim()
        : stripNulBytes(stripLegacyToolCallMarkup(fullText));
    if (textOnly && harvested.length === 0) {
      content.push({ type: "text", text: textOnly });
    }

    // Convert harvested to Anthropic tool_use blocks
    for (const call of harvested) {
      content.push({
        type: "tool_use",
        id: call.callId,
        name: call.name,
        input: call.input,
      });
    }

    if (content.length === 0) {
      content.push({ type: "text", text: fullText || "" });
    }

    const response: Record<string, unknown> = {
      id: "msg_mimo_" + Date.now().toString(36),
      type: "message",
      role: "assistant",
      content,
      model: resolvedModel,
      stop_reason: harvested.length > 0 ? "tool_use" : "end_turn",
      usage: {
        input_tokens: usage?.promptTokens ?? 0,
        output_tokens: usage?.completionTokens ?? 0,
      },
    };
    if (harvested.length > 0) {
      response.__rcc_tool_governance = {
        textHarvestApplied: true,
      };
    }

    return response as UnknownObject;
  }

  private hasStructuredToolMarker(text: string): boolean {
    return /<tool_?call(?:\s|>)/i.test(text)
      || /<function_calls?>/i.test(text)
      || /<invoke(?:\s|>)/i.test(text)
      || /"tool_calls"\s*:/i.test(text)
      || /"function_calls"\s*:/i.test(text);
  }

  private extractHarvestedToolCalls(message: Record<string, unknown>): Array<{ name: string; input: Record<string, unknown>; callId: string }> {
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const out: Array<{ name: string; input: Record<string, unknown>; callId: string }> = [];
    for (const entry of toolCalls) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const row = entry as Record<string, unknown>;
      const fn =
        row.function && typeof row.function === "object" && !Array.isArray(row.function)
          ? (row.function as Record<string, unknown>)
          : undefined;
      const name =
        (typeof fn?.name === "string" && fn.name.trim())
        || (typeof row.name === "string" && row.name.trim())
        || "";
      if (!name) {
        continue;
      }
      const rawArgs =
        (typeof fn?.arguments === "string" ? fn.arguments : undefined)
        ?? (typeof row.arguments === "string" ? row.arguments : undefined);
      let input: Record<string, unknown> = {};
      if (rawArgs) {
        try {
          const parsed = JSON.parse(rawArgs);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          input = {};
        }
      }
      const callId =
        (typeof row.call_id === "string" && row.call_id.trim())
        || (typeof row.id === "string" && row.id.trim())
        || crypto.randomUUID().replace(/-/g, "");
      out.push({ name, input, callId });
    }
    return out;
  }

  private isImmediateRepeatedToolRound(
    messages: Msg[],
    harvested: Array<{ name: string; input: Record<string, unknown>; callId: string }>,
  ): boolean {
    if (harvested.length === 0) {
      return false;
    }
    const previousSignatures = extractImmediateMatchedToolRound(messages);
    if (previousSignatures.length === 0 || previousSignatures.length !== harvested.length) {
      return false;
    }
    const currentSignatures = harvested.map((entry) => buildToolSignature(entry));
    previousSignatures.sort();
    currentSignatures.sort();
    return previousSignatures.every((value, index) => value === currentSignatures[index]);
  }
}
