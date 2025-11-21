export interface RouteSelectionContext {
  routePools: Record<string, string[]>;
}

export async function selectRouteName(payload: any, entryEndpoint: string, ctx: RouteSelectionContext): Promise<string> {
  try {
    // 预留真正的虚拟路由逻辑；当前简单返回 default（若存在）
    if (ctx.routePools && typeof ctx.routePools === 'object') {
      if (ctx.routePools['default']) return 'default';
      const keys = Object.keys(ctx.routePools);
      if (keys.length) return keys[0];
    }
  } catch {}
  return 'default';
}

