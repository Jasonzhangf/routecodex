import type { ClassificationResult, RoutingFeatures, VirtualRouterClassifierConfig } from './types.js';
import { DEFAULT_ROUTE, ROUTE_PRIORITY } from './types.js';

const DEFAULT_LONG_CONTEXT_THRESHOLD = 180000;

export class RoutingClassifier {
  private readonly config: VirtualRouterClassifierConfig;

  constructor(config: VirtualRouterClassifierConfig) {
    this.config = {
      longContextThresholdTokens: config.longContextThresholdTokens ?? DEFAULT_LONG_CONTEXT_THRESHOLD,
      thinkingKeywords: normalizeList(config.thinkingKeywords, ['think step', 'analysis', 'reasoning']),
      backgroundKeywords: normalizeList(config.backgroundKeywords, ['background', 'context dump'])
    };
  }

  classify(features: RoutingFeatures): ClassificationResult {
    const lastToolCategory = features.lastAssistantToolCategory;
    const webSearchIntent = detectWebSearchIntent(features.userTextSample);
    const serverToolRequired = (features.metadata as any)?.serverToolRequired === true;
    const hasWebSearchToolDeclared = features.hasWebSearchToolDeclared === true;
    const webSearchContinuation = lastToolCategory === 'websearch';
    const localToolContinuation =
      lastToolCategory === 'read' ||
      lastToolCategory === 'write' ||
      lastToolCategory === 'search' ||
      lastToolCategory === 'other';
    const webSearchFromIntent = !localToolContinuation && webSearchIntent;
    const webSearchDeclaredOrRequired =
      !localToolContinuation && (serverToolRequired || hasWebSearchToolDeclared);
    const reachedLongContext =
      features.estimatedTokens >= (this.config.longContextThresholdTokens ?? DEFAULT_LONG_CONTEXT_THRESHOLD);
    const latestMessageFromUser = features.latestMessageFromUser === true;
    const thinkingContinuation = lastToolCategory === 'read';
    const thinkingFromUser = latestMessageFromUser;
    const thinkingFromRead = !thinkingFromUser && thinkingContinuation;
    const codingContinuation = lastToolCategory === 'write';
    const searchContinuation = lastToolCategory === 'search';
    const toolsContinuation = lastToolCategory === 'other';
    const hasToolActivity = features.hasTools || features.hasToolCallResponses;
    const hasRemoteVideoAttachment = features.hasVideoAttachment === true && features.hasRemoteVideoAttachment === true;

    const evaluationMap: Record<string, { triggered: boolean; reason: string }> = {
      video: {
        triggered: hasRemoteVideoAttachment,
        reason: 'video:remote-video-detected'
      },
      multimodal: {
        triggered: features.hasImageAttachment,
        reason: 'multimodal:media-detected'
      },
      thinking: {
        triggered: thinkingFromUser || thinkingFromRead,
        reason: thinkingFromUser ? 'thinking:user-input' : 'thinking:last-tool-read'
      },
      longcontext: {
        triggered: reachedLongContext,
        reason: 'longcontext:token-threshold'
      },
      coding: {
        triggered: codingContinuation,
        reason: 'coding:last-tool-write'
      },
      web_search: {
        // web_search 路由触发条件（按优先级）：
        // 1) 上一轮 assistant 已触发 websearch 类工具（续写命中）
        // 2) 本轮已标记 serverToolRequired（例如 stage1 注入 websearch 工具）
        // 3) 用户输入命中联网搜索意图关键词
        triggered:
          webSearchContinuation ||
          webSearchDeclaredOrRequired ||
          webSearchFromIntent,
        reason:
          webSearchContinuation
            ? 'web_search:last-tool-websearch'
            : webSearchDeclaredOrRequired && serverToolRequired
              ? 'web_search:servertool-required'
              : webSearchDeclaredOrRequired && hasWebSearchToolDeclared
                ? 'web_search:tool-declared'
              : 'web_search:intent-keyword'
      },
      search: {
        // search 路由：仅在上一轮 assistant 使用 search 类工具时继续命中，
        // 不因本轮是否声明 web_search 工具而改变路由。
        triggered: searchContinuation,
        reason: 'search:last-tool-search'
      },
      tools: {
        // tools 路由：通用工具分支，包括首次声明的 web/search 工具。
        // 若上一轮已明确归类为 search，则优先命中 search 路由，tools 仅作为兜底。
        triggered: toolsContinuation || (!searchContinuation && hasToolActivity),
        reason: toolsContinuation ? 'tools:last-tool-other' : 'tools:tool-request-detected'
      },
      background: {
        triggered: containsKeywords(features.userTextSample, this.config.backgroundKeywords ?? []),
        reason: 'background:keywords'
      }
    };

    for (const routeName of ROUTE_PRIORITY) {
      const evaluation = evaluationMap[routeName];
      if (evaluation && evaluation.triggered) {
        const candidates = this.ensureDefaultCandidate([routeName]);
        return this.buildResult(routeName, evaluation.reason, evaluationMap, candidates);
      }
    }

    const candidates = this.ensureDefaultCandidate([DEFAULT_ROUTE]);
    return this.buildResult(DEFAULT_ROUTE, 'fallback:default', evaluationMap, candidates);
  }

  private buildResult(
    routeName: string,
    chosenReason: string,
    evaluations: Record<string, { triggered: boolean; reason: string }>,
    candidates: string[]
  ): ClassificationResult {
    const diagnostics = Object.entries(evaluations)
      .filter(([_, evaluation]) => evaluation.triggered)
      .map(([_, evaluation]) => evaluation.reason);
    const reasoningParts = [chosenReason, ...diagnostics.filter((reason) => reason !== chosenReason)];
    return {
      routeName,
      confidence: 0.9,
      reasoning: reasoningParts.join('|'),
      fallback: routeName === DEFAULT_ROUTE,
      candidates: candidates.length ? candidates : [DEFAULT_ROUTE]
    };
  }

  private ensureDefaultCandidate(routes: string[]): string[] {
    const deduped = routes.filter(Boolean);
    if (!deduped.includes(DEFAULT_ROUTE)) {
      deduped.push(DEFAULT_ROUTE);
    }
    return deduped;
  }

  private orderRoutes(routes: string[]): string[] {
    const unique = Array.from(new Set(routes.filter(Boolean)));
    return unique.sort((a, b) => this.routeWeight(a) - this.routeWeight(b));
  }

  private routeWeight(route: string): number {
    const index = ROUTE_PRIORITY.indexOf(route);
    return index >= 0 ? index : ROUTE_PRIORITY.length;
  }
}

function detectWebSearchIntent(text: string): boolean {
  if (!text || !text.trim()) {
    return false;
  }

  const normalized = text.toLowerCase();
  if (isNegativeWebSearchContext(normalized, text)) {
    return false;
  }

  const directKeywords = [
    'web search',
    'web_search',
    'websearch',
    'search the web',
    'internet search',
    '搜索网页',
    '联网搜索',
    '上网搜索',
    '上网查',
    '网上搜',
    '谷歌搜索',
    'google search'
  ];
  if (directKeywords.some((keyword) => normalized.includes(keyword))) {
    return true;
  }

  const enVerb = ['search', 'find', 'lookup', 'look up', 'google'];
  const enNoun = ['web', 'internet', 'online', 'google', 'bing'];
  const hasEnVerb = enVerb.some((keyword) => normalized.includes(keyword));
  const hasEnNoun = enNoun.some((keyword) => normalized.includes(keyword));
  if (hasEnVerb && hasEnNoun) {
    return true;
  }

  const zhVerb = ['搜索', '查找', '搜', '上网查', '上网搜', '联网查', '联网搜'];
  const zhNoun = ['网络', '联网', '网页', '网上', '互联网', '谷歌', '百度'];
  const hasZhVerb = zhVerb.some((keyword) => text.includes(keyword));
  const hasZhNoun = zhNoun.some((keyword) => text.includes(keyword));
  if ((text.includes('上网') || text.includes('联网')) && (text.includes('搜') || text.includes('查'))) {
    return true;
  }
  if (hasZhVerb && hasZhNoun) {
    return true;
  }

  return false;
}

function isNegativeWebSearchContext(normalized: string, originalText: string): boolean {
  const englishPatterns = [
    /prefer\s+resources?\s+over\s+web[\s_-]?search/u,
    /prefer[\s\S]{0,40}web[\s_-]?search/u,
    /do\s+not[\s\S]{0,20}web[\s_-]?search/u,
    /don't[\s\S]{0,20}web[\s_-]?search/u,
    /without[\s\S]{0,20}web[\s_-]?search/u,
    /cannot[\s\S]{0,20}web[\s_-]?search/u
  ];
  if (englishPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const chinesePatterns = [
    /不能.{0,20}(上网|联网|web[_ -]?search|搜索网页)/u,
    /不要.{0,20}(上网|联网|web[_ -]?search|搜索网页)/u,
    /避免.{0,20}(上网|联网|web[_ -]?search|搜索网页)/u
  ];
  return chinesePatterns.some((pattern) => pattern.test(originalText));
}

function normalizeList(source: string[] | undefined, fallback: string[]): string[] {
  if (!source || source.length === 0) {
    return fallback;
  }
  return source.map((item) => item.toLowerCase());
}

function containsKeywords(text: string, keywords: string[]): boolean {
  if (!text || !keywords.length) {
    return false;
  }
  const normalized = text.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword));
}
