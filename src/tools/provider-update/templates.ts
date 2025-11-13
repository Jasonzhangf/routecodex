type ModelTemplate = Record<string, unknown>;

// Provider-agnostic templates keyed by canonical model name (case-insensitive)
const NAME_TEMPLATES: Record<string, ModelTemplate> = {
  'qwen3-coder-480b-a35b': { maxTokens: 64000, maxContext: 256000 },
  'qwen3-coder-480b-a35b-instruct': { maxTokens: 64000, maxContext: 256000 },
  'qwen3-coder-plus': { maxTokens: 64000, maxContext: 256000 },
  'qwen3-vl-plus': { maxTokens: 32000, maxContext: 256000 },
  'glm-4.6': { maxTokens: 128000, maxContext: 200000, supportsThinking: true },
  'kimi-k2-instruct-0905': { maxTokens: 64000, maxContext: 256000 },
  'kimi-for-coding': { maxTokens: 64000, maxContext: 256000 },
  'deepseek-v3.2-exp': { maxTokens: 64000, maxContext: 128000 },
  'deepseek-v3.1-terminus': { maxTokens: 64000, maxContext: 128000 },
  'deepseek-r1': { maxTokens: 32000, maxContext: 128000 },
  'qwen3-235b-a22b-thinking': { maxTokens: 64000, maxContext: 256000 },
  'qwen3-235b-a22b-instruct': { maxTokens: 64000, maxContext: 256000 }
};

// Backward compatibility for provider-qualified keys
const QUALIFIED_TEMPLATES: Record<string, ModelTemplate> = {
  'glm.glm-4.6': { maxTokens: 128000, maxContext: 200000, supportsThinking: true }
};

function canonicalizeName(modelId: string): string {
  try {
    // Take last segment after '/'
    const seg = modelId.split('/').pop() || modelId;
    // Remove trailing version-like suffixes (e.g., -2507, -2410)
    const noVer = seg.replace(/-[0-9]{3,}$/i, '');
    return noVer.trim().toLowerCase();
  } catch { return String(modelId || '').toLowerCase(); }
}

export function applyTemplates(providerId: string, modelId: string, existing: Record<string, unknown> | undefined): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(existing || {}) };
  // Provider-qualified exact match
  const qKey = `${providerId}.${modelId}`;
  let tpl = QUALIFIED_TEMPLATES[qKey];
  if (!tpl) {
    const cname = canonicalizeName(modelId);
    // direct match
    tpl = NAME_TEMPLATES[cname];
    if (!tpl) {
      // prefix match (e.g., qwen3-235b-a22b-thinking-2507 → qwen3-235b-a22b-thinking)
      const hit = Object.entries(NAME_TEMPLATES).find(([k]) => cname.startsWith(k));
      if (hit) tpl = hit[1];
    }
  }
  if (tpl) {
    for (const [k, v] of Object.entries(tpl)) {
      if (base[k] === undefined) base[k] = v;
    }
  }
  // Default stream capability unless explicitly disabled
  if (base['supportsStreaming'] === undefined) base['supportsStreaming'] = true;
  return base;
}
