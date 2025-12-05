export function extractToolText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join('');
  }
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch {
      return '';
    }
  }
  return content === null || content === undefined ? '' : String(content);
}
