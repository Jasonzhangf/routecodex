// Shared JSON argument parsing helpers.
// Goal: tolerate common markup artifacts injected by upstream providers (e.g. <arg_key>/<arg_value>),
// while keeping behavior deterministic and side-effect free.

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stripXmlLikeTags = (input: string): string => {
  try {
    return String(input || '').replace(/<[^>]+>/g, '');
  } catch {
    return input;
  }
};

const stripArgKeyArtifacts = (input: string): string => {
  try {
    return String(input || '')
      .replace(/<\/?\s*tool_call[^>]*>/gi, '')
      .replace(/<\/?\s*arg_key\s*>/gi, '')
      .replace(/<\/?\s*arg_value\s*>/gi, '');
  } catch {
    return input;
  }
};

const repairArgKeyArtifactsInRawJson = (input: string): string => {
  try {
    let out = String(input || '');
    if (!out.includes('<arg_key') && !out.includes('<arg_value') && !out.includes('</arg_key') && !out.includes('</arg_value')) {
      return out;
    }
    // Repair patterns like: "file</arg_key><arg_value>a.ts" -> "file":"a.ts"
    out = out.replace(
      /"([^"]+?)\s*<\/?\s*arg_key\s*>\s*<\/?\s*arg_value\s*>([^"]*?)"/gi,
      '"$1":"$2"'
    );
    // Strip remaining tag artifacts after pair repair.
    out = stripArgKeyArtifacts(out);
    return out;
  } catch {
    return input;
  }
};

const normalizeObjectKey = (rawKey: string): string => {
  const cleaned = stripXmlLikeTags(stripArgKeyArtifacts(rawKey)).trim();
  if (!cleaned) return rawKey;
  return cleaned;
};

const coercePrimitive = (raw: string): unknown => {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^(true|false)$/i.test(trimmed)) return /^true$/i.test(trimmed);
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
};

const extractInjectedArgPairs = (
  raw: string
): { baseValue: string; pairs: Array<{ key: string; value: unknown }> } | null => {
  const delimiter = '</arg_key><arg_value>';
  if (typeof raw !== 'string' || !raw.includes(delimiter)) return null;
  const parts = raw.split(delimiter);
  if (parts.length < 2) return null;

  const looksLikeKey = (s: string): boolean => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(s.trim());

  const pairs: Array<{ key: string; value: unknown }> = [];
  let baseValue = parts[0] ?? '';

  if (parts.length === 2) {
    const k = (parts[0] ?? '').trim();
    const v = (parts[1] ?? '').trim();
    if (looksLikeKey(k) && v.length > 0) {
      baseValue = '';
      pairs.push({ key: k, value: coercePrimitive(v) });
    }
    return pairs.length ? { baseValue, pairs } : null;
  }

  for (let i = 1; i + 1 < parts.length; i += 2) {
    const key = (parts[i] ?? '').trim();
    const rawValue = (parts[i + 1] ?? '').trim();
    if (!looksLikeKey(key)) {
      continue;
    }
    if (rawValue.length === 0) {
      continue;
    }
    pairs.push({ key, value: coercePrimitive(rawValue) });
  }

  if (!pairs.length) return null;
  return { baseValue, pairs };
};

const repairArgKeyArtifactsInKeys = (value: unknown): void => {
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (!isRecord(node)) return;

    const keys = Object.keys(node);
    for (const key of keys) {
      const normalizedKey = normalizeObjectKey(key);
      if (normalizedKey !== key && normalizedKey.trim()) {
        if (!Object.prototype.hasOwnProperty.call(node, normalizedKey)) {
          (node as any)[normalizedKey] = (node as any)[key];
        }
        delete (node as any)[key];
      }
    }

    for (const v of Object.values(node)) visit(v);
  };
  visit(value);
};

const repairArgKeyArtifactsInObject = (value: unknown): void => {
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (!isRecord(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') {
        const injected = extractInjectedArgPairs(v);
        if (injected) {
          if (injected.baseValue !== '') {
            (node as any)[k] = injected.baseValue;
          }
          for (const pair of injected.pairs) {
            if (!Object.prototype.hasOwnProperty.call(node, pair.key)) {
              (node as any)[pair.key] = pair.value;
            }
          }
        }
      }
      visit((node as any)[k]);
    }
  };
  visit(value);
};

export function parseToolArgsJson(input: unknown): unknown {
  const raw = typeof input === 'string' ? input : '';
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    repairArgKeyArtifactsInKeys(parsed);
    repairArgKeyArtifactsInObject(parsed);
    return parsed;
  } catch {
    // attempt raw string repair for arg_key/arg_value artifacts
    try {
      const repairedRaw = repairArgKeyArtifactsInRawJson(raw).trim();
      if (repairedRaw && repairedRaw !== raw) {
        const parsed = JSON.parse(repairedRaw);
        repairArgKeyArtifactsInKeys(parsed);
        repairArgKeyArtifactsInObject(parsed);
        return parsed;
      }
    } catch {
      // continue
    }
    // try stripping common tool-call markup artifacts and parsing again
    try {
      const stripped = stripArgKeyArtifacts(raw).trim();
      if (stripped && stripped !== raw) {
        const parsed = JSON.parse(stripped);
        repairArgKeyArtifactsInKeys(parsed);
        repairArgKeyArtifactsInObject(parsed);
        return parsed;
      }
    } catch {
      // continue
    }
    // attempt to parse the first JSON container substring
    try {
      const candidate = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/)?.[0];
      if (candidate) {
        const strippedCandidate = stripArgKeyArtifacts(candidate).trim();
        const parsed = JSON.parse(strippedCandidate);
        repairArgKeyArtifactsInKeys(parsed);
        repairArgKeyArtifactsInObject(parsed);
        return parsed;
      }
    } catch {
      // ignore
    }
    return {};
  }
}
