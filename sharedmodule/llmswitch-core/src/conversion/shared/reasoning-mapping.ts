export interface ReasoningItem {
  type: 'reasoning';
  content: string;
}

export function mapReasoningContentToResponsesOutput(reasoningContent: any): ReasoningItem[] {
  if (!reasoningContent) return [];
  const text = Array.isArray(reasoningContent)
    ? reasoningContent.map((r: any) => (typeof r?.text === 'string' ? r.text : '')).filter(Boolean).join('\n')
    : (typeof reasoningContent?.text === 'string' ? reasoningContent.text : '');
  return text ? [{ type: 'reasoning', content: text }] : [];
}

