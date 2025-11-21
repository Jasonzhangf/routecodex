export interface RouteSelectionContext {
  routePools: Record<string, string[]>;
  routeMeta?: Record<string, { providerId: string; modelId: string; keyId: string }>;
}

export async function selectRouteName(payload: any, entryEndpoint: string, ctx: RouteSelectionContext): Promise<string> {
  try {
    const pools = ctx.routePools || {};
    const keys = Object.keys(pools);
    const has = (name: string) => Array.isArray((pools as any)[name]) && (pools as any)[name].length > 0;
    // 优先 default 且非空
    if (has('default')) return 'default';
    // 按入口端点做一个简单偏好（可扩展）：responses → 选择包含 responses 能力的池（routeMeta 暂不强约束）
    if (entryEndpoint === '/v1/responses') {
      const k = keys.find((k) => has(k));
      if (k) return k;
    }
    // 退回首个非空池
    const nonEmpty = keys.find((k) => has(k));
    if (nonEmpty) return nonEmpty;
    // 所有池为空：返回第一个键（用于更清晰的错误信息），若无键则 default
    const anyKey = keys[0];
    if (anyKey) return anyKey;
  } catch {}
  return 'default';
}
