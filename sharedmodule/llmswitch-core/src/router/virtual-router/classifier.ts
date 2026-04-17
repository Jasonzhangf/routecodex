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
    const webSearchContinuation = lastToolCategory === 'websearch';
    const localToolContinuation =
      lastToolCategory === 'read' ||
      lastToolCategory === 'write' ||
      lastToolCategory === 'search' ||
      lastToolCategory === 'other';
    const reachedLongContext =
      features.estimatedTokens >= (this.config.longContextThresholdTokens ?? DEFAULT_LONG_CONTEXT_THRESHOLD);
    const latestMessageFromUser = features.latestMessageFromUser === true;
    const hasToolActivity = features.hasTools || features.hasToolCallResponses;
    const thinkingContinuation = lastToolCategory === 'read';
    // Jason 规则：只要当前轮仍是用户输入，就优先按 thinking 路由处理，
    // 不再因为历史 tool 响应或本轮声明 tools/search 而降到 tools/search。
    // tools/search/coding 续写只保留给非用户输入的 followup/tool 轮。
    const thinkingFromUser = latestMessageFromUser;
    const thinkingFromRead = !thinkingFromUser && thinkingContinuation;
    const codingContinuation = lastToolCategory === 'write';
    const searchContinuation = lastToolCategory === 'search';
    const toolsContinuation = lastToolCategory === 'other';
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
        // web_search 路由只允许由显式 web_search 工具链续写命中。
        // 不再因为用户“想联网搜索”或 serverToolRequired 自动切到 web_search，
        // 以避免产生隐式联网流量；首次显式工具请求仍走 tools 路由。
        triggered: !localToolContinuation && webSearchContinuation,
        reason: 'web_search:last-tool-websearch'
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
