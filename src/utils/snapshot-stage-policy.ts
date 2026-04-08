const DEFAULT_SNAPSHOT_ALLOWED_STAGES = Object.freeze([
  'client-request',
  'http-request',
  'provider-request',
  'provider-response',
  'provider-error',
  'provider-request.retry',
  'provider-response.retry'
]);

type SnapshotStagePolicy = {
  allowAll: boolean;
  exact: Set<string>;
  prefixes: string[];
};

let cachedPolicyKey = '';
let cachedPolicy: SnapshotStagePolicy | null = null;

function normalizeStageToken(value: string): string {
  return value.trim().toLowerCase();
}

function splitStageTokens(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((token) => normalizeStageToken(token))
    .filter((token) => token.length > 0);
}

function readSnapshotStagesSelector(): string {
  return String(
    process.env.ROUTECODEX_SNAPSHOT_STAGES
    ?? process.env.RCC_SNAPSHOT_STAGES
    ?? ''
  ).trim();
}

function compileSnapshotStagePolicy(selectorRaw: string): SnapshotStagePolicy {
  const selector = selectorRaw.trim();
  if (!selector) {
    return {
      allowAll: false,
      exact: new Set(DEFAULT_SNAPSHOT_ALLOWED_STAGES),
      prefixes: []
    };
  }
  const tokens = splitStageTokens(selector);
  if (!tokens.length) {
    return {
      allowAll: false,
      exact: new Set(DEFAULT_SNAPSHOT_ALLOWED_STAGES),
      prefixes: []
    };
  }
  if (tokens.some((token) => token === '*' || token === 'all')) {
    return {
      allowAll: true,
      exact: new Set(),
      prefixes: []
    };
  }
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const token of tokens) {
    if (token.endsWith('*') && token.length > 1) {
      prefixes.push(token.slice(0, -1));
      continue;
    }
    exact.add(token);
  }
  return {
    allowAll: false,
    exact,
    prefixes
  };
}

function resolveSnapshotStagePolicy(): SnapshotStagePolicy {
  const selector = readSnapshotStagesSelector();
  if (cachedPolicy && cachedPolicyKey === selector) {
    return cachedPolicy;
  }
  cachedPolicyKey = selector;
  cachedPolicy = compileSnapshotStagePolicy(selector);
  return cachedPolicy;
}

export function getDefaultSnapshotStageSelector(): string {
  return DEFAULT_SNAPSHOT_ALLOWED_STAGES.join(',');
}

export function shouldCaptureSnapshotStage(stage: string): boolean {
  const normalized = normalizeStageToken(stage || '');
  if (!normalized) {
    return false;
  }
  const policy = resolveSnapshotStagePolicy();
  if (policy.allowAll) {
    return true;
  }
  if (policy.exact.has(normalized)) {
    return true;
  }
  return policy.prefixes.some((prefix) => normalized.startsWith(prefix));
}

export function stageSelectorNeedsHubSnapshots(selectorRaw: string): boolean {
  const selector = selectorRaw.trim();
  if (!selector) {
    return false;
  }
  const tokens = splitStageTokens(selector);
  if (tokens.some((token) => token === '*' || token === 'all')) {
    return true;
  }
  return tokens.some((token) => {
    const base = token.endsWith('*') ? token.slice(0, -1) : token;
    if (!base) {
      return false;
    }
    if (
      base === 'client-request'
      || base === 'http-request'
      || base.startsWith('provider-')
    ) {
      return false;
    }
    if (base.startsWith('client-') || base.startsWith('http-') || base.startsWith('llm-switch-')) {
      return false;
    }
    return true;
  });
}

