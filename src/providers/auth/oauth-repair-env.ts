type ScopedEnv = Record<string, string | undefined>;

function setEnvScoped(next: Record<string, string | undefined>): () => void {
  const prev: ScopedEnv = {};
  for (const [key, value] of Object.entries(next)) {
    prev[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

export async function withOAuthRepairEnv<T>(providerType: string, fn: () => Promise<T>): Promise<T> {
  const pt = providerType.toLowerCase();
  if (pt === 'antigravity') {
    const restore = setEnvScoped({
      ROUTECODEX_OAUTH_BROWSER: 'camoufox',
      ROUTECODEX_CAMOUFOX_AUTO_MODE: 'antigravity',
      ROUTECODEX_OAUTH_AUTO_CONFIRM: '1'
    });
    try {
      return await fn();
    } finally {
      restore();
    }
  }
  if (pt === 'iflow') {
    const restore = setEnvScoped({
      ROUTECODEX_OAUTH_BROWSER: 'camoufox',
      ROUTECODEX_CAMOUFOX_AUTO_MODE: 'iflow',
      ROUTECODEX_OAUTH_AUTO_CONFIRM: '1'
    });
    try {
      return await fn();
    } finally {
      restore();
    }
  }
  if (pt === 'qwen') {
    const restore = setEnvScoped({
      ROUTECODEX_OAUTH_BROWSER: 'camoufox',
      ROUTECODEX_CAMOUFOX_AUTO_MODE: 'qwen',
      ROUTECODEX_OAUTH_AUTO_CONFIRM: '1'
    });
    try {
      return await fn();
    } finally {
      restore();
    }
  }
  if (pt === 'gemini' || pt === 'gemini-cli') {
    const restore = setEnvScoped({
      ROUTECODEX_OAUTH_BROWSER: 'camoufox',
      ROUTECODEX_CAMOUFOX_AUTO_MODE: 'gemini',
      ROUTECODEX_OAUTH_AUTO_CONFIRM: '1'
    });
    try {
      return await fn();
    } finally {
      restore();
    }
  }
  return fn();
}
