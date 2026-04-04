export type ProviderRoutingScope = {
  providerKeys?: unknown;
};

export type ResolvedProviderRoutingScope = {
  hasRoutingProviderScope: boolean;
  routedProviderKeys: Set<string>;
  isInRoutingScope: (providerKey: string) => boolean;
};

export function resolveProviderRoutingScope(scope: ProviderRoutingScope | null | undefined): ResolvedProviderRoutingScope {
  const hasRoutingProviderScope = Array.isArray(scope?.providerKeys);
  const routedProviderKeys = new Set<string>(
    hasRoutingProviderScope
      ? (scope!.providerKeys as unknown[])
          .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
          .filter(Boolean)
      : []
  );
  const isInRoutingScope = (providerKey: string): boolean => {
    if (!hasRoutingProviderScope) {
      return true;
    }
    return routedProviderKeys.has(String(providerKey || '').trim().toLowerCase());
  };
  return {
    hasRoutingProviderScope,
    routedProviderKeys,
    isInRoutingScope
  };
}

