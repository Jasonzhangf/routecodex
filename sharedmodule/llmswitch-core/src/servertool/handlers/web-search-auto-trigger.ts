import type { JsonObject, JsonValue } from '../../conversion/hub/types/json.js';
import type { ServerToolBackendPlan, ServerToolHandlerResult, ServerToolExecution } from '../types.js';
import { cloneJson } from '../server-side-tools.js';
import type { ServerToolBackendResult } from '../types.js';

export function extractAutoSearchQuery(base: JsonObject): string | undefined {
  const messages = Array.isArray((base as { messages?: unknown }).messages)
    ? ((base as { messages: JsonValue[] }).messages as JsonObject[])
    : [];
  const lastUserMsg = messages.filter((m: JsonObject) => (m as { role?: unknown }).role === 'user').pop();
  if (!lastUserMsg) return undefined;
  const content = (lastUserMsg as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content.trim() || undefined;
  }
  if (Array.isArray(content)) {
    const textParts = content.filter((c: JsonValue) =>
      typeof c === 'string' || (typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text')
    );
    const text = textParts.map((c: JsonValue) =>
      typeof c === 'string' ? c : ((c as { text?: unknown }).text ?? '')
    ).join(' ').trim();
    return text || undefined;
  }
  return undefined;
}

export function buildAutoSearchBackendPlan(
  query: string,
  engines: Array<{ id: string; providerKey: string }>
): ServerToolBackendPlan {
  return {
    kind: 'web_search',
    requestIdSuffix: ':auto_web_search',
    query,
    resultCount: 10,
    engines
  };
}

export function buildAutoSearchInjectionResult(
  base: JsonObject,
  backendResult: ServerToolBackendResult,
  query: string
): ServerToolHandlerResult {
  if (backendResult.kind !== 'web_search') {
    throw new Error('Expected web_search backend result');
  }
  const summary = backendResult.result?.summary || '';
  const hits = backendResult.result?.hits || [];
  const timestamp = new Date().toISOString();

  const systemContent = [
    '用户输入：' + query,
    '',
    '相关内置搜索结果（内置搜索，' + timestamp + '）：',
    summary,
    '',
    '来源：',
    ...hits.slice(0, 5).map((h, i) => (i + 1) + '. ' + (h.title || '无标题') + ' - ' + h.link),
    '',
    '你可以使用内置搜索工具 "websearch" 进行更多搜索。'
  ].join('\n');

  const cloned = cloneJson(base);
  const messages = Array.isArray((cloned as { messages?: unknown }).messages)
    ? ((cloned as { messages: JsonValue[] }).messages as JsonObject[])
    : [];

  (cloned as Record<string, unknown>).messages = [
    { role: 'system', content: systemContent } as JsonObject,
    ...messages
  ];

  const existingTools = Array.isArray((cloned as { tools?: unknown }).tools)
    ? ((cloned as { tools: JsonValue[] }).tools as JsonObject[])
    : [];

  const hasWebsearch = existingTools.some((t: JsonObject) => {
    const fn = (t as { function?: unknown }).function;
    if (!fn || typeof fn !== 'object') return false;
    const name = (fn as { name?: unknown }).name;
    return name === 'websearch' || name === 'web_search';
  });

  if (!hasWebsearch) {
    const websearchTool: JsonObject = {
      type: 'function',
      function: {
        name: 'websearch',
        description: 'Search the web for information. Use this tool when you need to find real-time or external information.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            count: { type: 'number', description: 'Number of results to return (default: 10)' },
            recency: { type: 'string', description: 'Time filter (e.g. "1d", "1w", "1m")' }
          },
          required: ['query']
        }
      }
    };
    (cloned as Record<string, unknown>).tools = [...existingTools, websearchTool];
  }

  const execution: ServerToolExecution = {
    flowId: 'web_search_flow'
  };

  return {
    chatResponse: cloned,
    execution
  };
}
