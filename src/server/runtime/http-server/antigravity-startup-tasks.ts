export type AntigravityQuotaModule = {
  disableProvider?: (options: { providerKey: string; mode: 'cooldown' | 'blacklist'; durationMs: number }) => Promise<unknown>;
};

export function collectAntigravityAliases(runtimeMap: Record<string, unknown>): string[] {
  const aliases: string[] = [];
  for (const [providerKey, runtime] of Object.entries(runtimeMap)) {
    const key = typeof providerKey === 'string' ? providerKey.trim() : '';
    const runtimeKey =
      runtime && typeof (runtime as { runtimeKey?: unknown }).runtimeKey === 'string'
        ? String((runtime as { runtimeKey: string }).runtimeKey).trim()
        : '';
    for (const candidate of [runtimeKey, key]) {
      if (!candidate.toLowerCase().startsWith('antigravity.')) {
        continue;
      }
      const parts = candidate.split('.');
      if (parts.length >= 2 && parts[1] && parts[1].trim()) {
        aliases.push(parts[1].trim());
      }
    }
  }
  return aliases;
}

export function buildAntigravityAliasMap(runtimeMap: Record<string, unknown>): Map<string, string[]> {
  const providerKeysByAlias = new Map<string, string[]>();
  for (const providerKey of Object.keys(runtimeMap)) {
    const key = typeof providerKey === 'string' ? providerKey.trim() : '';
    if (!key.toLowerCase().startsWith('antigravity.')) {
      continue;
    }
    const parts = key.split('.');
    if (parts.length < 3) {
      continue;
    }
    const alias = parts[1]?.trim();
    if (!alias) {
      continue;
    }
    const list = providerKeysByAlias.get(alias) || [];
    list.push(key);
    providerKeysByAlias.set(alias, list);
  }
  return providerKeysByAlias;
}

export function filterAntigravityAliasMapByProviderKeys(
  aliasMap: Map<string, string[]>,
  allowedProviderKeys: Set<string>,
  options?: { scopeApplied?: boolean }
): Map<string, string[]> {
  if (!allowedProviderKeys.size) {
    if (options?.scopeApplied) {
      return new Map<string, string[]>();
    }
    return aliasMap;
  }
  const next = new Map<string, string[]>();
  for (const [alias, keys] of aliasMap.entries()) {
    const filtered = keys.filter((key) => allowedProviderKeys.has(String(key || '').trim().toLowerCase()));
    if (filtered.length > 0) {
      next.set(alias, filtered);
    }
  }
  return next;
}

export function startAntigravityPreload(
  aliases: string[],
  dependencies?: {
    primeAntigravityUserAgentVersion?: () => Promise<unknown>;
    preloadAntigravityAliasUserAgents?: (aliases: string[]) => Promise<unknown>;
  }
): void {
  if (!aliases.length) {
    return;
  }
  void (async () => {
    try {
      const loaded = dependencies ?? await import('../../../providers/auth/antigravity-user-agent.js');
      const prime = loaded.primeAntigravityUserAgentVersion;
      const preload = loaded.preloadAntigravityAliasUserAgents;
      if (typeof prime !== 'function' || typeof preload !== 'function') {
        return;
      }
      await Promise.allSettled([prime(), preload(aliases)]);
    } catch {
      // best-effort
    }
  })();
}

export function startAntigravityWarmup(
  providerKeysByAlias: Map<string, string[]>,
  quotaModule?: AntigravityQuotaModule,
  dependencies?: {
    isAntigravityWarmupEnabled?: () => boolean;
    getAntigravityWarmupBlacklistDurationMs?: () => number;
    warmupCheckAntigravityAlias?: (alias: string) => Promise<{
      ok: boolean;
      profileId?: string;
      fingerprintOs?: string;
      fingerprintArch?: string;
      actualSuffix?: string;
      actualUserAgent?: string;
      expectedSuffix?: string;
      reason?: string;
      tokenFile?: string;
      fromSuffix?: string;
      toSuffix?: string;
    }>;
  }
): void {
  if (providerKeysByAlias.size === 0) {
    return;
  }
  void (async () => {
    try {
      const loaded = dependencies ?? await import('../../../providers/auth/antigravity-warmup.js');
      const enabled = loaded.isAntigravityWarmupEnabled;
      const readDuration = loaded.getAntigravityWarmupBlacklistDurationMs;
      const checkWarmup = loaded.warmupCheckAntigravityAlias;
      if (typeof enabled !== 'function' || typeof readDuration !== 'function' || typeof checkWarmup !== 'function') {
        return;
      }
      if (!enabled()) {
        return;
      }
      const canBlacklist = Boolean(quotaModule && typeof quotaModule.disableProvider === 'function');
      const durationMs = readDuration();
      let okCount = 0;
      let failCount = 0;
      for (const [alias, providerKeys] of providerKeysByAlias.entries()) {
        const result = await checkWarmup(alias);
        if (result.ok) {
          okCount += 1;
          console.log(
            `[antigravity:warmup] ok alias=${alias} profile=${result.profileId} fp_os=${result.fingerprintOs} fp_arch=${result.fingerprintArch} ua_suffix=${result.actualSuffix} ua=${result.actualUserAgent}`
          );
          continue;
        }
        failCount += 1;
        const expected = result.expectedSuffix ? ` expected=${result.expectedSuffix}` : '';
        const actual = result.actualSuffix ? ` actual=${result.actualSuffix}` : '';
        const hint =
          result.reason === 'linux_not_allowed'
            ? ` hint="run: routecodex camoufox-fp repair --provider antigravity --alias ${alias}"`
            : result.reason === 'reauth_required'
              ? ` hint="run: routecodex oauth antigravity-auto ${result.tokenFile || `antigravity-oauth-*-` + alias + `.json`}"` +
                `${result.fromSuffix ? ` from=${result.fromSuffix}` : ''}${result.toSuffix ? ` to=${result.toSuffix}` : ''}`
              : '';
        console.error(
          `[antigravity:warmup] FAIL alias=${alias} profile=${result.profileId}${result.fingerprintOs ? ` fp_os=${result.fingerprintOs}` : ''}${result.fingerprintArch ? ` fp_arch=${result.fingerprintArch}` : ''} reason=${result.reason}${expected}${actual}${hint} providerKeys=${providerKeys.length}${canBlacklist ? '' : ' (quota module unavailable; cannot blacklist)'}`
        );
        if (canBlacklist) {
          await Promise.allSettled(
            providerKeys.map((providerKey) => quotaModule!.disableProvider!({ providerKey, mode: 'blacklist', durationMs }))
          );
        }
      }
      console.log(`[antigravity:warmup] summary ok=${okCount} fail=${failCount} total=${providerKeysByAlias.size}`);
    } catch {
      // best-effort
    }
  })();
}
