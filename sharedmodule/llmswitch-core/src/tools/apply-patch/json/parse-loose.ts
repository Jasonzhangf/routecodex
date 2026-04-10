const tryParseJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
};

const escapeUnescapedQuotesInJsonStrings = (input: string): string => {
  // Best-effort: when JSON is almost valid but contains unescaped `"` inside string values
  // (e.g. JSX snippets like className="..."), escape quotes that are not followed by a
  // valid JSON token delimiter. Deterministic; does not attempt to fix structural issues.
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] ?? '';
    if (!inString) {
      if (ch === '"') {
        inString = true;
        escaped = false;
      }
      out += ch;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j] ?? '')) j += 1;
      const next = j < input.length ? input[j] : '';
      if (next === '' || next === ':' || next === ',' || next === '}' || next === ']') {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
};

const balanceJsonContainers = (input: string): string => {
  // Best-effort bracket/brace balancing for JSON-like strings.
  // Only operates outside string literals. When encountering a closing token that doesn't
  // match the current stack top, inserts the missing closer(s) to recover.
  let out = '';
  let inString = false;
  let escaped = false;
  const stack: Array<'{' | '['> = [];

  const closeFor = (open: '{' | '['): '}' | ']' => (open === '{' ? '}' : ']');

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] ?? '';

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === '{' || ch === '[') {
      stack.push(ch);
      out += ch;
      continue;
    }

    if (ch === '}' || ch === ']') {
      const expectedOpen: '{' | '[' = ch === '}' ? '{' : '[';
      while (stack.length && stack[stack.length - 1] !== expectedOpen) {
        const open = stack.pop() as '{' | '[';
        out += closeFor(open);
      }
      if (stack.length && stack[stack.length - 1] === expectedOpen) {
        stack.pop();
      }
      out += ch;
      continue;
    }

    out += ch;
  }

  while (stack.length) {
    const open = stack.pop() as '{' | '[';
    out += closeFor(open);
  }

  return out;
};

const tryParseJsonLoose = (value: unknown): unknown => {
  const parsed = tryParseJson(value);
  if (parsed !== undefined) return parsed;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return undefined;
  let repaired = escapeUnescapedQuotesInJsonStrings(trimmed);
  repaired = balanceJsonContainers(repaired);
  if (!repaired || repaired === trimmed) return undefined;
  try {
    return JSON.parse(repaired);
  } catch {
    return undefined;
  }
};

export { tryParseJson, tryParseJsonLoose };

