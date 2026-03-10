import { describe, expect, test } from '@jest/globals';

import { RoutingClassifier } from '../../src/router/virtual-router/classifier.js';
import { buildRoutingFeatures } from '../../src/router/virtual-router/features.js';

function classifyRoute(userContent: string): string {
  return classifyRouteFromMessages([{ role: 'user', content: userContent }]);
}

function classifyRouteFromMessages(messages: Array<{ role: string; content: string }>): string {
  const req = {
    model: 'gpt-test',
    messages,
    tools: []
  } as any;

  const features = buildRoutingFeatures(req, { requestId: 'req_test' } as any);
  const classifier = new RoutingClassifier({});
  return classifier.classify(features).routeName;
}

describe('virtual-router web_search intent detection', () => {
  test('does not misclassify generic progress text as web_search', () => {
    const route = classifyRoute('显示实时的进度查询和结果统计，输出成功与失败数量。');
    expect(route).not.toBe('web_search');
  });

  test('does not classify policy text mentioning web search as web_search intent', () => {
    const route = classifyRoute('Prefer resources over web search when possible.');
    expect(route).not.toBe('web_search');
  });

  test('classifies explicit Chinese web search request as web_search', () => {
    const route = classifyRoute('请帮我联网搜索今天的 OpenAI 新闻。');
    expect(route).toBe('web_search');
  });

  test('classifies explicit English web search request as web_search', () => {
    const route = classifyRoute('Please search the web for the latest OpenAI API pricing.');
    expect(route).toBe('web_search');
  });

  test('ignores system prompt text when user has no web search intent', () => {
    const route = classifyRouteFromMessages([
      { role: 'system', content: 'Prefer resources over web search when possible.' },
      { role: 'user', content: '继续拆分模块并补回归测试。' }
    ]);
    expect(route).not.toBe('web_search');
  });

  test('does not use historical user intent when latest turn is not user', () => {
    const route = classifyRouteFromMessages([
      { role: 'user', content: '请帮我联网搜索最新新闻。' },
      { role: 'assistant', content: '好的，我先检查仓库结构。' }
    ]);
    expect(route).not.toBe('web_search');
  });
});
