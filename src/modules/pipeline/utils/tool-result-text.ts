/**
 * Shared utility: extract human-readable text from a tool result payload.
 *
 * Preference order:
 * - output -> text -> content (string)
 * - if content is an array, recursively flatten items' text/content
 * - if the value is a JSON-stringified object/array, parse then retry
 * - otherwise synthesize a deterministic summary from metadata (exit_code/duration)
 */

export function extractToolText(value: unknown): string {
  const push = (arr: string[], s?: string) => {
    if (typeof s === 'string') {
      const t = s.trim();
      if (t) arr.push(t);
    }
  };
  const flattenParts = (v: unknown): string[] => {
    const texts: string[] = [];
    if (Array.isArray(v)) {
      for (const p of v) {
        if (!p) continue;
        if (typeof p === 'string') {
          push(texts, p);
          continue;
        }
        if (p && typeof p === 'object') {
          const obj: any = p as any;
          if (typeof obj.text === 'string') {
            push(texts, obj.text);
            continue;
          }
          if (typeof obj.content === 'string') {
            push(texts, obj.content);
            continue;
          }
          if (Array.isArray(obj.content)) {
            texts.push(...flattenParts(obj.content));
            continue;
          }
        }
      }
    }
    return texts;
  };

  // String case: if it looks like JSON, parse then retry
  if (typeof value === 'string') {
    const s = value.trim();
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try {
        const parsed = JSON.parse(s);
        const t = extractToolText(parsed);
        if (t) return t;
      } catch { /* ignore parse errors */ }
    }
    return value;
  }

  // Object case
  if (value && typeof value === 'object') {
    const obj: any = value as any;
    // Priority: text -> content(string) -> content(array flatten) -> output(non-empty) -> metadata summary
    if (typeof obj.text === 'string' && obj.text.trim().length > 0) return String(obj.text);
    if (typeof obj.content === 'string' && obj.content.trim().length > 0) return String(obj.content);
    if (Array.isArray(obj.content)) {
      const t = flattenParts(obj.content).join('\n').trim();
      if (t) return t;
    }
    if (typeof obj.output === 'string' && obj.output.trim().length > 0) return String(obj.output);
    // Deterministic summary when no text present
    try {
      const meta: any = obj.metadata || obj.meta || {};
      const parts: string[] = [];
      if (typeof meta.exit_code === 'number') parts.push(`exit_code: ${meta.exit_code}`);
      if (typeof meta.duration_seconds === 'number') parts.push(`duration: ${meta.duration_seconds}s`);
      if (!parts.length && typeof obj.exit_code === 'number') parts.push(`exit_code: ${obj.exit_code}`);
      if (!parts.length && typeof obj.duration_seconds === 'number') parts.push(`duration: ${obj.duration_seconds}s`);
      if (parts.length) return parts.join(', ');
    } catch { /* ignore */ }
  }

  // Array case
  if (Array.isArray(value)) {
    const t = flattenParts(value).join('\n').trim();
    if (t) return t;
  }

  return '';
}
