import type { JsonObject, JsonValue } from '../../conversion/hub/types/json.js';
import { buildOpenAIChatFromGeminiResponse } from '../../conversion/codecs/gemini-openai-codec.js';
import type { ServerSideToolEngineOptions, ServerToolBackendPlan, ServerToolBackendResult, ServerToolHandler, ServerToolHandlerContext, ServerToolHandlerPlan, ToolCall } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { cloneJson, extractTextFromChatLike } from '../server-side-tools.js';
import {
  extractCapturedChatSeed
} from './followup-request-builder.js';
import { reenterServerToolBackend } from '../reenter-backend.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';

interface WebSearchEngineConfig {
  id: string;
  providerKey: string;
  description?: string;
  default?: boolean;
  executionMode?: 'servertool' | 'direct';
  directActivation?: 'route' | 'builtin';
  modelId?: string;
  maxUses?: number;
  serverToolsDisabled?: boolean;
  // Optional: backend-specific engine list for providers like iFlow
  searchEngineList?: string[];
}

interface WebSearchConfig {
  engines: WebSearchEngineConfig[];
  injectPolicy?: 'always' | 'selective';
  force?: boolean;
}

interface WebSearchItem {
  title?: string;
  link: string;
  media?: string;
  publish_date?: string;
  content?: string;
  refer?: string;
}

interface WebSearchBackendResult {
  summary: string;
  hits: WebSearchItem[];
  ok: boolean;
}

const FLOW_ID = 'web_search_flow';

const handler: ServerToolHandler = async (ctx: ServerToolHandlerContext): Promise<ServerToolHandlerPlan | null> => {
  const toolCall = ctx.toolCall;
  if (!toolCall) {
    return null;
  }
  if (!ctx.capabilities.providerInvoker && !ctx.capabilities.reenterPipeline) {
    return null;
  }

  const webSearchConfig = getWebSearchConfig(ctx.adapterContext);
  const hasConfig = !!webSearchConfig && Array.isArray(webSearchConfig.engines) && webSearchConfig.engines.length > 0;
  const forceMode = webSearchConfig?.force === true;
  const envEnabled = resolveEnvServerSideToolsEnabled();
  if (!hasConfig && !forceMode && !envEnabled) {
    return null;
  }

  const parsedArgs = parseToolArguments(toolCall);
  const query =
    typeof parsedArgs.query === 'string' && parsedArgs.query.trim() ? (parsedArgs.query as string).trim() : undefined;
  if (!query) {
    return null;
  }

  const engines = webSearchConfig ? buildEnginePriorityList(webSearchConfig, parsedArgs.engine) : [];
  if (!engines.length) {
    return null;
  }

  const resultCount = normalizeResultCount(parsedArgs.count);

  const recency =
    typeof parsedArgs.recency === 'string' && parsedArgs.recency.trim() ? (parsedArgs.recency as string).trim() : undefined;
  const backend: ServerToolBackendPlan = {
    kind: 'web_search',
    requestIdSuffix: ':web_search',
    query,
    ...(recency ? { recency } : {}),
    resultCount,
    engines
  };

  return {
    flowId: FLOW_ID,
    backend,
    finalize: async ({ backendResult }) => {
      if (!backendResult || backendResult.kind !== 'web_search') {
        return null;
      }
      const chosen = backendResult.chosenEngine;
      if (!chosen || !chosen.id || !chosen.providerKey) {
        return null;
      }
      const patched = injectWebSearchToolResult(
        ctx.base,
        toolCall,
        { id: chosen.id, providerKey: chosen.providerKey },
        query,
        backendResult.result
      );

      const seed = extractCapturedChatSeed((ctx.adapterContext as any)?.capturedChatRequest);
      const assistantMessage = seed ? extractAssistantMessage(patched) : null;
      const toolMessages = seed ? buildToolMessages(patched) : [];
      const canFollowup = Boolean(seed && assistantMessage && toolMessages.length > 0);

      return {
        chatResponse: patched,
        execution: {
          flowId: FLOW_ID,
          ...(canFollowup
            ? {
              followup: {
                requestIdSuffix: ':web_search_followup',
                entryEndpoint: ctx.entryEndpoint,
                injection: {
                  ops: [
                    { op: 'append_assistant_message' },
                    { op: 'append_tool_messages_from_tool_outputs' },
                    { op: 'drop_tool_by_name', name: 'web_search' }
                  ]
                }
              }
            }
            : {}),
          context: {
            web_search: {
              engineId: chosen.id,
              providerKey: chosen.providerKey,
              summary: backendResult.result.summary
            }
          } as JsonObject
        }
      };
    }
  };
};

registerServerToolHandler('web_search', handler);

function parseToolArguments(toolCall: ToolCall): Record<string, unknown> {
  if (!toolCall.arguments || typeof toolCall.arguments !== 'string') {
    return {};
  }
  try {
    return JSON.parse(toolCall.arguments) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getWebSearchConfig(ctx: unknown): WebSearchConfig | undefined {
  const rt = readRuntimeMetadata(ctx as Record<string, unknown>);
  const raw = rt ? (rt as any).webSearch : undefined;
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { engines?: unknown }) : null;
  if (!record) return undefined;
  const enginesRaw = Array.isArray(record.engines) ? record.engines : [];
  const engines: WebSearchEngineConfig[] = [];
  for (const entry of enginesRaw) {
    const obj =
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as Record<string, JsonValue>)
        : null;
    if (!obj) continue;
    const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : undefined;
    const providerKey = typeof obj.providerKey === 'string' && obj.providerKey.trim()
      ? obj.providerKey.trim()
      : undefined;
    if (!id || !providerKey) continue;
    const rawExecutionMode =
      typeof obj.executionMode === 'string'
        ? obj.executionMode.trim().toLowerCase()
        : typeof obj.mode === 'string'
          ? obj.mode.trim().toLowerCase()
          : '';
    const executionMode = rawExecutionMode === 'direct' ? 'direct' : 'servertool';
    const rawDirectActivation =
      typeof obj.directActivation === 'string'
        ? obj.directActivation.trim().toLowerCase()
        : typeof obj.activation === 'string'
          ? obj.activation.trim().toLowerCase()
          : '';
    const directActivation =
      rawDirectActivation === 'builtin'
        ? 'builtin'
        : rawDirectActivation === 'route'
          ? 'route'
          : executionMode === 'direct'
            ? 'route'
            : undefined;
    const modelId = typeof obj.modelId === 'string' && obj.modelId.trim() ? obj.modelId.trim() : undefined;
    const rawMaxUses = typeof obj.maxUses === 'number' ? obj.maxUses : Number(obj.maxUses);
    const maxUses = Number.isFinite(rawMaxUses) && rawMaxUses > 0 ? Math.floor(rawMaxUses) : undefined;
    const serverToolsDisabled =
      obj.serverToolsDisabled === true ||
      (typeof obj.serverToolsDisabled === 'string' &&
        obj.serverToolsDisabled.trim().toLowerCase() === 'true') ||
      (obj.serverTools &&
        typeof obj.serverTools === 'object' &&
        (obj.serverTools as Record<string, JsonValue>).enabled === false);
    let searchEngineList: string[] | undefined;
    const rawSearchList = obj.searchEngineList;
    if (Array.isArray(rawSearchList)) {
      const normalizedList: string[] = [];
      for (const item of rawSearchList) {
        if (typeof item === 'string' && item.trim().length) {
          normalizedList.push(item.trim());
        }
      }
      if (normalizedList.length) {
        searchEngineList = normalizedList;
      }
    }
    engines.push({
      id,
      providerKey,
      description: typeof obj.description === 'string' && obj.description.trim() ? obj.description.trim() : undefined,
      default: obj.default === true,
      executionMode,
      ...(directActivation ? { directActivation } : {}),
      ...(modelId ? { modelId } : {}),
      ...(maxUses ? { maxUses } : {}),
      ...(serverToolsDisabled ? { serverToolsDisabled: true } : {}),
      ...(searchEngineList ? { searchEngineList } : {})
    });
  }
  if (!engines.length) {
    return undefined;
  }
  const config: WebSearchConfig = { engines };
  if (typeof (record as any).injectPolicy === 'string') {
    const val = String((record as any).injectPolicy).trim().toLowerCase();
    if (val === 'always' || val === 'selective') {
      config.injectPolicy = val;
    }
  }
  if (
    (record as any).force === true ||
    (typeof (record as any).force === 'string' && String((record as any).force).trim().toLowerCase() === 'true')
  ) {
    config.force = true;
  }
  return config;
}

function resolveWebSearchEngine(config: WebSearchConfig, engineId?: unknown): WebSearchEngineConfig | undefined {
  const trimmedId = typeof engineId === 'string' && engineId.trim() ? engineId.trim() : undefined;
  if (trimmedId) {
    const byId = config.engines.find((e) => e.id === trimmedId);
    if (byId && !byId.serverToolsDisabled) {
      return byId;
    }
  }
  const byDefault = config.engines.find((e) => e.default && !e.serverToolsDisabled);
  if (byDefault && !byDefault.serverToolsDisabled) {
    return byDefault;
  }
  if (config.engines.length === 1) {
    const single = config.engines[0];
    return single.serverToolsDisabled ? undefined : single;
  }
  return undefined;
}

function buildEnginePriorityList(config: WebSearchConfig, engineId?: unknown): WebSearchEngineConfig[] {
  const engines = (Array.isArray(config.engines) ? config.engines : []).filter(
    (engine) => !engine.serverToolsDisabled && (engine.executionMode ?? 'servertool') === 'servertool'
  );
  if (!engines.length) {
    return [];
  }
  const primary = resolveWebSearchEngine(config, engineId);
  if (!primary) {
    return [...engines];
  }
  const ordered: WebSearchEngineConfig[] = [primary];
  for (const engine of engines) {
    if (engine !== primary) {
      ordered.push(engine);
    }
  }
  return ordered;
}

function resolveEnvServerSideToolsEnabled(): boolean {
  const raw =
    (process.env.ROUTECODEX_SERVER_SIDE_TOOLS || process.env.RCC_SERVER_SIDE_TOOLS || '').trim().toLowerCase();
  if (!raw) return false;
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  if (raw === 'web_search') return true;
  return false;
}

function isGeminiWebSearchEngine(engine: WebSearchEngineConfig): boolean {
  const key = engine.providerKey.toLowerCase();
  return (
    key.startsWith('gemini-cli.') ||
    key.startsWith('antigravity.') ||
    key.startsWith('gemini.')
  );
}

function isIflowWebSearchEngine(engine: WebSearchEngineConfig): boolean {
  const key = engine.providerKey.toLowerCase();
  return key.startsWith('iflow.');
}

function isQwenWebSearchEngine(engine: WebSearchEngineConfig): boolean {
  const key = engine.providerKey.toLowerCase();
  return key.startsWith('qwen.');
}

function normalizeResultCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    if (normalized >= 5 && normalized <= 15) {
      return normalized;
    }
  }
  return 10;
}

async function executeWebSearchBackend(args: {
  options: ServerSideToolEngineOptions;
  engine: WebSearchEngineConfig;
  query: string;
  recency?: unknown;
  resultCount: number;
  requestSuffix: string;
}): Promise<WebSearchBackendResult> {
  const { options, engine, query } = args;
  const recency =
    typeof args.recency === 'string' && args.recency.trim() ? (args.recency as string).trim() : undefined;

  let summary = '';
  let hits: WebSearchItem[] = [];
  let ok = true;
  try {
    logServerToolWebSearch(engine, options.requestId, query);
    const requestSuffix = args.requestSuffix;

    // 对于 iFlow，直接通过 providerInvoker 调用 /chat/retrieve，
    // 即使 reenterPipeline 可用，也不走 Chat 模型 + tools。
    if (isIflowWebSearchEngine(engine) && options.providerInvoker) {
      const backendResult = await executeIflowWebSearchViaProvider({
        options,
        engine,
        query,
        recency,
        count: args.resultCount,
        requestSuffix
      });
      summary = backendResult.summary;
      hits = backendResult.hits;
      ok = backendResult.ok;
    } else if (isQwenWebSearchEngine(engine) && options.providerInvoker) {
      const backendResult = await executeQwenWebSearchViaProvider({
        options,
        engine,
        query,
        count: args.resultCount,
        requestSuffix
      });
      summary = backendResult.summary;
      hits = backendResult.hits;
      ok = backendResult.ok;
    } else if (options.reenterPipeline) {
      const payload = buildWebSearchReenterPayload(engine, query, recency, args.resultCount);
      const followup = await reenterServerToolBackend({
        reenterPipeline: options.reenterPipeline,
        entryEndpoint: '/v1/chat/completions',
        requestId: `${options.requestId}${requestSuffix}`,
        body: payload,
        providerProtocol: 'openai-chat',
        routeHint: 'web_search'
      });
      const body = followup.body && typeof followup.body === 'object' ? (followup.body as JsonObject) : null;
      if (body) {
        summary = extractTextFromChatLike(body);
        hits = collectWebSearchHits(body);
        if (!summary && process.env.ROUTECODEX_DEBUG_GLM_WEB_SEARCH === '1') {
          try {
            // eslint-disable-next-line no-console
            console.log(
              '\x1b[38;5;27m[server-tool][web_search][backend_debug]' +
                ` requestId=${options.requestId}${requestSuffix} payload=${JSON.stringify(body).slice(0, 2000)}\x1b[0m`
            );
          } catch {
            /* logging best-effort */
          }
        }
      }
    } else if (options.providerInvoker) {
      summary = await executeWebSearchViaProvider({
        options,
        engine,
        query,
        recency,
        count: args.resultCount,
        requestSuffix
      });
      hits = [];
    }
  } catch (error) {
    ok = false;
    const message =
      error instanceof Error && typeof error.message === 'string' && error.message.trim()
        ? sanitizeBackendError(error.message.trim())
        : 'web_search backend failed';
    summary =
      `web_search failed: ${message}. ` +
      '请调整搜索关键词（例如减少敏感描述或换一种说法）后重试，这只是当前查询被阻止。';
  }

  if (!summary) {
    if (hits.length) {
      summary = formatHitsSummary(hits);
    } else {
      summary =
        'web_search completed but returned no textual summary. ' +
        '可以尝试修改搜索词、增加时间范围或换一个更具体的描述后再次搜索。';
    }
  }

  try {
    const preview = summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
    // eslint-disable-next-line no-console
    console.log(
      `\x1b[38;5;27m[server-tool][web_search][result] requestId=${options.requestId} ` +
        `engine=${engine.id} chars=${summary.length} preview=${JSON.stringify(preview)}\x1b[0m`
    );
  } catch {
    /* logging best-effort */
  }

  const finalHits = limitHits(hits);
  if (!summary) {
    summary = formatHitsSummary(finalHits);
  }
  if (finalHits.length > 0 && finalHits.length < 5) {
    summary = `${summary}\n（当前仅返回${finalHits.length}条可用结果，可尝试调整关键词或时间范围以获取更多。）`;
  }
  return { summary, hits: finalHits, ok };
}

export async function executeWebSearchBackendPlan(args: {
  plan: Extract<ServerToolBackendPlan, { kind: 'web_search' }>;
  options: ServerSideToolEngineOptions;
}): Promise<ServerToolBackendResult> {
  const plan = args.plan;
  const options = args.options;
  const engines = Array.isArray(plan.engines) ? plan.engines : [];
  if (!engines.length) {
    return { kind: 'web_search', result: { ok: false, summary: '', hits: [] } };
  }

  let chosenEngine: WebSearchEngineConfig | undefined;
  let chosenResult: WebSearchBackendResult | undefined;
  let lastFailure: { engine: WebSearchEngineConfig; result: WebSearchBackendResult } | undefined;

  for (const engine of engines) {
    const requestSuffix = `${plan.requestIdSuffix}:${engine.id}`;
    const backendResult = await executeWebSearchBackend({
      options,
      engine,
      query: plan.query,
      recency: plan.recency,
      resultCount: plan.resultCount,
      requestSuffix
    });
    if (backendResult.ok) {
      chosenEngine = engine;
      chosenResult = backendResult;
      break;
    }
    lastFailure = { engine, result: backendResult };
  }

  if (!chosenEngine || !chosenResult) {
    if (!lastFailure) {
      return { kind: 'web_search', result: { ok: false, summary: '', hits: [] } };
    }
    chosenEngine = lastFailure.engine;
    chosenResult = lastFailure.result;
  }

  return {
    kind: 'web_search',
    chosenEngine: { id: chosenEngine.id, providerKey: chosenEngine.providerKey },
    result: { ok: chosenResult.ok, summary: chosenResult.summary, hits: chosenResult.hits }
  };
}

function buildWebSearchReenterPayload(
  engine: WebSearchEngineConfig,
  query: string,
  recency: string | undefined,
  resultCount: number
): JsonObject {
  const systemPrompt = buildWebSearchSystemPrompt(resultCount);

  const basePayload: JsonObject = {
    model: engine.id,
    messages: [
      {
        role: 'system',
        content: systemPrompt
      },
      {
        role: 'user',
        content: query
      }
    ],
    stream: false
  };

  if (isGeminiWebSearchEngine(engine)) {
    return basePayload;
  }

  return {
    ...basePayload,
    web_search: {
      query,
      ...(recency ? { recency } : {}),
      count: resultCount,
      engine: engine.id
    }
  } as JsonObject;
}

async function executeWebSearchViaProvider(args: {
  options: ServerSideToolEngineOptions;
  engine: WebSearchEngineConfig;
  query: string;
  recency?: string;
  count: number;
  requestSuffix: string;
}): Promise<string> {
  const { options, engine, query, recency, count, requestSuffix } = args;
  if (!options.providerInvoker) {
    return '';
  }

  if (isGeminiWebSearchEngine(engine)) {
    const geminiPayload: JsonObject = {
      model: engine.id,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: query
            }
          ]
        }
      ],
      tools: [
        {
          googleSearch: {}
        }
      ]
    };

    const backend = await options.providerInvoker({
      providerKey: engine.providerKey,
      providerType: undefined,
      modelId: engine.id,
      providerProtocol: 'gemini-chat',
      payload: geminiPayload,
      entryEndpoint: '/v1/models/gemini:generateContent',
      requestId: `${options.requestId}${requestSuffix}`,
      routeHint: 'web_search'
    });
    const providerResponse = backend.providerResponse && typeof backend.providerResponse === 'object'
      ? (backend.providerResponse as JsonObject)
      : null;
    if (!providerResponse) {
      return '';
    }
    const chatLike = buildOpenAIChatFromGeminiResponse(providerResponse);
    return chatLike ? extractTextFromChatLike(chatLike) : '';
  }

  const backendPayload: JsonObject = {
    model: engine.id,
    messages: [
      {
        role: 'system',
        content: 'You are a web search engine. Answer with up-to-date information based on the open internet.'
      },
      {
        role: 'user',
        content: query
      }
    ],
    stream: false,
    web_search: {
      query,
      ...(recency ? { recency } : {}),
      count: args.count,
      engine: engine.id
    }
  };

  const backend = await options.providerInvoker({
    providerKey: engine.providerKey,
    providerType: undefined,
    modelId: undefined,
    providerProtocol: options.providerProtocol,
    payload: backendPayload,
    entryEndpoint: '/v1/chat/completions',
    requestId: `${options.requestId}${requestSuffix}`,
    routeHint: 'web_search'
  });
  const providerResponse = backend.providerResponse && typeof backend.providerResponse === 'object'
    ? (backend.providerResponse as JsonObject)
    : null;
  if (!providerResponse) {
    return '';
  }
  return extractTextFromChatLike(providerResponse);
}

async function executeIflowWebSearchViaProvider(args: {
  options: ServerSideToolEngineOptions;
  engine: WebSearchEngineConfig;
  query: string;
  recency?: string;
  count: number;
  requestSuffix: string;
}): Promise<WebSearchBackendResult> {
  const { options, engine, query, count, requestSuffix } = args;
  if (!options.providerInvoker) {
    return {
      summary: '',
      hits: [],
      ok: false
    };
  }

  const searchEngineList =
    Array.isArray(engine.searchEngineList) && engine.searchEngineList.length
      ? engine.searchEngineList
      : ['GOOGLE', 'BING', 'SCHOLAR', 'AIPGC', 'PDF'];

  const searchBody: JsonObject = {
    query,
    history: {},
    userId: 2,
    userIp: '42.120.74.197',
    appCode: 'SEARCH_CHATBOT',
    chatId: Date.now(),
    phase: 'UNIFY',
    enableQueryRewrite: false,
    enableRetrievalSecurity: false,
    enableIntention: false,
    searchEngineList
  };

  let providerKey = engine.providerKey;
  try {
    const adapter = options.adapterContext && typeof options.adapterContext === 'object'
      ? (options.adapterContext as unknown as { target?: unknown })
      : null;
    const target = adapter && adapter.target && typeof adapter.target === 'object'
      ? (adapter.target as { providerKey?: unknown })
      : null;
    const targetProviderKey =
      target && typeof target.providerKey === 'string' && target.providerKey.trim()
        ? target.providerKey.trim()
        : undefined;
    if (targetProviderKey) {
      providerKey = targetProviderKey;
    }
  } catch {
    // best-effort: fallback to engine.providerKey
  }

  const payload: JsonObject = {
    data: searchBody,
    metadata: {
      entryEndpoint: '/chat/retrieve',
      iflowWebSearch: true,
      routeName: 'web_search'
    }
  };

  const backend = await options.providerInvoker({
    providerKey,
    providerType: undefined,
    modelId: undefined,
    providerProtocol: options.providerProtocol,
    payload,
    entryEndpoint: '/v1/chat/retrieve',
    requestId: `${options.requestId}${requestSuffix}`,
    routeHint: 'web_search'
  });

  const providerResponse = backend.providerResponse && typeof backend.providerResponse === 'object'
    ? (backend.providerResponse as JsonObject)
    : null;
  if (!providerResponse) {
    return {
      summary: '',
      hits: [],
      ok: false
    };
  }

  const container = providerResponse as { data?: unknown; success?: unknown; message?: unknown };
  const rawHits = Array.isArray(container.data) ? (container.data as JsonValue[]) : [];

  const hits: WebSearchItem[] = [];
  for (const item of rawHits) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as {
      title?: unknown;
      url?: unknown;
      time?: unknown;
      abstractInfo?: unknown;
    };
    const link = typeof record.url === 'string' && record.url.trim() ? record.url.trim() : '';
    if (!link) continue;
    const title =
      typeof record.title === 'string' && record.title.trim() ? record.title.trim() : undefined;
    const publishDate =
      typeof record.time === 'string' && record.time.trim() ? record.time.trim() : undefined;
    const content =
      typeof record.abstractInfo === 'string' && record.abstractInfo.trim()
        ? record.abstractInfo.trim()
        : undefined;
    hits.push({
      title,
      link,
      publish_date: publishDate,
      content
    });
    if (hits.length >= count) {
      break;
    }
  }

  let summary = '';
  if (typeof container.message === 'string' && container.message.trim()) {
    summary = container.message.trim();
  }
  if (!summary && hits.length) {
    summary = formatHitsSummary(hits);
  }

  const successField = container.success;
  const ok = typeof successField === 'boolean' ? successField : hits.length > 0;

  return {
    summary,
    hits,
    ok
  };
}

async function executeQwenWebSearchViaProvider(args: {
  options: ServerSideToolEngineOptions;
  engine: WebSearchEngineConfig;
  query: string;
  count: number;
  requestSuffix: string;
}): Promise<WebSearchBackendResult> {
  const { options, engine, query, count, requestSuffix } = args;
  if (!options.providerInvoker) {
    return {
      summary: '',
      hits: [],
      ok: false
    };
  }

  const payload: JsonObject = {
    data: {
      model: engine.id,
      uq: query,
      page: 1,
      rows: count
    },
    metadata: {
      entryEndpoint: '/api/v1/indices/plugin/web_search',
      qwenWebSearch: true,
      routeName: 'web_search'
    }
  };

  const backend = await options.providerInvoker({
    providerKey: engine.providerKey,
    providerType: undefined,
    modelId: undefined,
    providerProtocol: options.providerProtocol,
    payload,
    entryEndpoint: '/api/v1/indices/plugin/web_search',
    requestId: `${options.requestId}${requestSuffix}`,
    routeHint: 'web_search'
  });

  const providerResponse = backend.providerResponse && typeof backend.providerResponse === 'object'
    ? (backend.providerResponse as JsonObject)
    : null;
  if (!providerResponse) {
    return {
      summary: '',
      hits: [],
      ok: false
    };
  }

  const container = providerResponse as {
    status?: unknown;
    message?: unknown;
    msg?: unknown;
    data?: unknown;
  };
  const status = typeof container.status === 'number' ? container.status : undefined;
  const message =
    typeof container.message === 'string' && container.message.trim()
      ? container.message.trim()
      : typeof container.msg === 'string' && container.msg.trim()
        ? container.msg.trim()
        : '';

  if (status !== undefined && status !== 0) {
    throw new Error(message || `qwen web_search failed with status=${status}`);
  }

  const dataNode = container.data && typeof container.data === 'object' && !Array.isArray(container.data)
    ? (container.data as { docs?: unknown })
    : undefined;
  const rawDocs = Array.isArray(dataNode?.docs) ? (dataNode?.docs as JsonValue[]) : [];

  const hits: WebSearchItem[] = [];
  for (const item of rawDocs) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as {
      title?: unknown;
      url?: unknown;
      link?: unknown;
      snippet?: unknown;
      content?: unknown;
      timestamp_format?: unknown;
      timestamp?: unknown;
      time?: unknown;
      source?: unknown;
    };
    const linkCandidate = typeof record.url === 'string' && record.url.trim()
      ? record.url.trim()
      : typeof record.link === 'string' && record.link.trim()
        ? record.link.trim()
        : '';
    if (!linkCandidate) continue;
    const title =
      typeof record.title === 'string' && record.title.trim() ? record.title.trim() : undefined;
    const content =
      typeof record.snippet === 'string' && record.snippet.trim()
        ? record.snippet.trim()
        : typeof record.content === 'string' && record.content.trim()
          ? record.content.trim()
          : undefined;
    const publishDate =
      typeof record.timestamp_format === 'string' && record.timestamp_format.trim()
        ? record.timestamp_format.trim()
        : typeof record.timestamp === 'string' && record.timestamp.trim()
          ? record.timestamp.trim()
          : typeof record.time === 'string' && record.time.trim()
            ? record.time.trim()
            : undefined;
    const media =
      typeof record.source === 'string' && record.source.trim() ? record.source.trim() : undefined;
    hits.push({
      title,
      link: linkCandidate,
      content,
      publish_date: publishDate,
      media
    });
    if (hits.length >= count) {
      break;
    }
  }

  const summary = message || (hits.length ? formatHitsSummary(hits) : '');
  const ok = status === 0 || hits.length > 0;

  return {
    summary,
    hits,
    ok
  };
}

function injectWebSearchToolResult(
  base: JsonObject,
  toolCall: ToolCall,
  engine: WebSearchEngineConfig,
  query: string,
  backendResult: WebSearchBackendResult
): JsonObject {
  const cloned = cloneJson(base);
  const existingOutputs = Array.isArray((cloned as { tool_outputs?: unknown }).tool_outputs)
    ? ((cloned as { tool_outputs: JsonValue[] }).tool_outputs as JsonValue[])
    : [];
  const resultsPayload = backendResult.hits.map((hit, index) => ({
    index: index + 1,
    title: hit.title ?? '',
    link: hit.link,
    snippet: hit.content ?? '',
    source: hit.media ?? '',
    publish_date: hit.publish_date ?? ''
  }));
  (cloned as Record<string, unknown>).tool_outputs = [
    ...existingOutputs,
    {
      tool_call_id: toolCall.id,
      name: 'web_search',
      content: JSON.stringify({
        engine: engine.id,
        query,
        summary: backendResult.summary,
        results: resultsPayload
      })
    }
  ];
  return cloned;
}

function extractAssistantMessage(chatResponse: JsonObject): JsonObject | null {
  const choices = Array.isArray((chatResponse as { choices?: unknown }).choices)
    ? ((chatResponse as { choices: JsonValue[] }).choices as JsonValue[])
    : [];
  if (!choices.length) return null;
  const firstChoice = choices[0] && typeof choices[0] === 'object' && !Array.isArray(choices[0])
    ? (choices[0] as JsonObject)
    : null;
  if (!firstChoice) return null;
  const assistantMessage = firstChoice.message && typeof firstChoice.message === 'object'
    ? (firstChoice.message as JsonObject)
    : null;
  return assistantMessage;
}

function buildToolMessages(chatResponse: JsonObject): JsonObject[] {
  const toolOutputs = Array.isArray((chatResponse as { tool_outputs?: unknown }).tool_outputs)
    ? ((chatResponse as { tool_outputs: JsonValue[] }).tool_outputs as JsonValue[])
    : [];
  const messages: JsonObject[] = [];
  for (const entry of toolOutputs) {
    if (!entry || typeof entry !== 'object') continue;
    const toolCallId = typeof (entry as { tool_call_id?: unknown }).tool_call_id === 'string'
      ? ((entry as { tool_call_id: string }).tool_call_id as string)
      : undefined;
    if (!toolCallId) continue;
    const name = typeof (entry as { name?: unknown }).name === 'string'
      ? ((entry as { name: string }).name as string)
      : 'web_search';
    const rawContent = (entry as { content?: unknown }).content;
    let contentText: string;
    if (typeof rawContent === 'string') {
      contentText = rawContent;
    } else {
      try {
        contentText = JSON.stringify(rawContent ?? {});
      } catch {
        contentText = String(rawContent ?? '');
      }
    }
    messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      name,
      content: contentText
    } as JsonObject);
  }
  return messages;
}

function logServerToolWebSearch(engine: WebSearchEngineConfig, requestId: string, query: string): void {
  const providerAlias = engine.providerKey.split('.')[0] || engine.providerKey;
  const backendLabel = `${providerAlias}:${engine.id}`;
  const prefix = `[server-tool][web_search][${backendLabel}]`;
  const line = `${prefix} requestId=${requestId} query=${JSON.stringify(query)}`;
  // eslint-disable-next-line no-console
  console.log(`\x1b[38;5;27m${line}\x1b[0m`);

  const vrPrefix = `[virtual-router][servertool][web_search]`;
  const vrBackend = `${engine.providerKey}:${engine.id}`;
  const vrLine = `${vrPrefix} requestId=${requestId} backend=${vrBackend}`;
  // eslint-disable-next-line no-console
  console.log(`\x1b[31m${vrLine}\x1b[0m`);
}

function findWebSearchArray(payload: JsonObject): JsonValue[] | undefined {
  let current: JsonObject | undefined = payload;
  const visited = new Set<JsonObject>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const hits = getArray((current as { web_search?: unknown }).web_search);
    if (hits.length) {
      return hits;
    }
    const nextData = (current as { data?: unknown }).data;
    if (nextData && typeof nextData === 'object' && !Array.isArray(nextData)) {
      current = nextData as JsonObject;
      continue;
    }
    const nextResponse = (current as { response?: unknown }).response;
    if (nextResponse && typeof nextResponse === 'object' && !Array.isArray(nextResponse)) {
      current = nextResponse as JsonObject;
      continue;
    }
    break;
  }
  return undefined;
}

function collectWebSearchHits(payload: JsonObject): WebSearchItem[] {
  const array = findWebSearchArray(payload);
  if (!array) {
    return [];
  }
  const hits: WebSearchItem[] = [];
  for (const entry of array) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, JsonValue>;
    const link = typeof record.link === 'string' && record.link.trim() ? record.link.trim() : '';
    if (!link) continue;
    hits.push({
      title: typeof record.title === 'string' ? record.title : undefined,
      link,
      media: typeof record.media === 'string' ? record.media : undefined,
      publish_date: typeof record.publish_date === 'string' ? record.publish_date : undefined,
      content: typeof record.content === 'string' ? record.content : undefined,
      refer: typeof record.refer === 'string' ? record.refer : undefined
    });
  }
  return hits;
}

function limitHits(hits: WebSearchItem[]): WebSearchItem[] {
  if (!hits.length) return [];
  const filtered = hits.slice(0, 15);
  if (filtered.length >= 5) {
    return filtered;
  }
  return filtered;
}

function formatHitsSummary(hits: WebSearchItem[]): string {
  if (!hits.length) {
    return '';
  }
  const segments: string[] = [];
  hits.forEach((hit, index) => {
    const idx = hit.refer && hit.refer.trim() ? hit.refer.trim() : String(index + 1);
    const headerParts: string[] = [];
    if (hit.title) headerParts.push(hit.title);
    if (hit.media) headerParts.push(hit.media);
    if (hit.publish_date) headerParts.push(hit.publish_date);
    const header = headerParts.length ? headerParts.join(' · ') : '搜索结果';
    const details = [hit.content, hit.link].filter(Boolean).join('\n');
    segments.push(`【${idx}】${header}\n${details}`);
  });
  return segments.join('\n\n');
}

function getArray(value: unknown): JsonValue[] {
  return Array.isArray(value) ? (value as JsonValue[]) : [];
}

function sanitizeBackendError(message: string): string {
  const lowered = message.toLowerCase();
  if (lowered.includes('contentfilter')) {
    return '搜索请求被后端暂时拒绝';
  }
  if (lowered.includes('instructions are not valid')) {
    return '搜索指令格式未被后端接受';
  }
  return message;
}

function buildWebSearchSystemPrompt(targetCount: number): string {
  const normalizedTarget = Math.max(5, Math.min(15, targetCount));
  const instructions = [
    'You are an up-to-date web search engine that aggregates public internet results.',
    `Return between 5 and 15 high-quality search results (aim for about ${normalizedTarget} when available).`,
    'Each result must include: title, source/media, publish date if available, a concise summary (<=200 characters), and a direct URL that users can click for verification.',
    'Prefer de-duplicated sources and include diverse outlets. If fewer than 5 results exist, return what you can find and explain the limitation.',
    'Only mention that the query was blocked when the backend explicitly rejects it, and encourage the user to adjust their keywords before retrying.',
    'Structure the answer so downstream systems can extract each result cleanly.'
  ];
  return instructions.join('\n');
}
