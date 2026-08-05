type AnyRecord = Record<string, unknown>;

function coerceAliasRecord(candidate: unknown): Record<string, string> | undefined {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined;
  }
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate as AnyRecord)) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      continue;
    }
    const trimmedKey = key.trim();
    const trimmedValue = value.trim();
    if (!trimmedKey.length || !trimmedValue.length) {
      continue;
    }
    output[trimmedKey] = trimmedValue;
  }
  return Object.keys(output).length ? output : undefined;
}

export function extractAnthropicToolAliasMap(source?: AnyRecord): Record<string, string> | undefined {
  if (!source) {
    return undefined;
  }
  const visited = new WeakSet<object>();
  const queue: Array<{ node: AnyRecord; depth: number }> = [{ node: source, depth: 0 }];
  const maxDepth = 5;
  while (queue.length) {
    const { node, depth } = queue.shift()!;
    if (visited.has(node)) {
      continue;
    }
    visited.add(node);
    const aliasCandidate = coerceAliasRecord((node as AnyRecord).anthropicToolNameMap);
    if (aliasCandidate) {
      return aliasCandidate;
    }
    if (depth >= maxDepth) {
      continue;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        queue.push({ node: value as AnyRecord, depth: depth + 1 });
      }
    }
  }
  return undefined;
}
