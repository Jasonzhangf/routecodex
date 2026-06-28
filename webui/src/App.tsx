import React, { useEffect, useMemo, useState } from 'react';

type MainTab = 'providers' | 'routing' | 'ops';
type OpsTab = 'stats' | 'control';
type DensityMode = 'compact' | 'comfortable';
type AdvancedTab = 'control';

export type ApiError = Error & {
  status?: number;
  path?: string;
  payload?: unknown;
};

export type AuthStatus = {
  authRequired: boolean;
  hasPassword: boolean;
  authenticated: boolean;
};

export type ProviderSummary = {
  id: string;
  type?: string;
  enabled?: boolean;
  baseURL?: string;
  modelCount?: number;
  modelsPreview?: string[];
  compatibilityProfile?: string;
  authType?: string;
};

export type RoutingSource = {
  path?: string;
  label?: string;
  kind?: string;
  version?: string;
  location?: string;
};

export type StatsRow = {
  providerKey?: string;
  model?: string;
  requestCount?: number;
  errorCount?: number;
  totalPromptTokens?: number;
  totalCompletionTokens?: number;
  totalOutputTokens?: number;
};

export type ProviderRuntimeKeyItem = {
  providerKey?: string;
};

export type PeriodStatsRow = {
  period?: string;
  requestCount?: number;
  errorCount?: number;
  totalPromptTokens?: number;
  totalCompletionTokens?: number;
  totalOutputTokens?: number;
};


export async function apiFetch<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers = new Headers(opts.headers || {});
  if (opts.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const res = await fetch(path, {
    ...opts,
    headers,
    credentials: 'same-origin'
  });

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const message =
      (json as any)?.error?.message ||
      (json as any)?.error?.code ||
      `HTTP ${res.status} ${res.statusText}`;
    const err: ApiError = new Error(String(message));
    err.status = res.status;
    err.path = path;
    err.payload = json;
    throw err;
  }

  return json as T;
}

export function textOf(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

export function readSessionValue(key: string): string {
  try {
    return sessionStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

export function writeSessionValue(key: string, value: string): void {
  try {
    if (!value) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export function formatInt(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value || 0);
  if (!Number.isFinite(n)) {
    return '0';
  }
  return Math.round(n).toLocaleString();
}

export function formatTs(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return '—';
  }
  try {
    return new Date(n).toLocaleString();
  } catch {
    return String(n);
  }
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const abs = Math.abs(ms);
  const sign = ms < 0 ? '-' : '';
  const sec = Math.round(abs / 1000);
  if (sec < 60) return `${sign}${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${sign}${min}m`;
  const hour = Math.round(min / 60);
  if (hour < 48) return `${sign}${hour}h`;
  const day = Math.round(hour / 24);
  return `${sign}${day}d`;
}

export function formatEpochWithDelta(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const delta = n - Date.now();
  const tail = delta >= 0 ? `in ${formatDurationMs(delta)}` : `${formatDurationMs(delta)} ago`;
  return `${formatTs(n)} (${tail})`;
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

export function parseJsonObject(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: 'JSON must be an object.' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function extractRoutingTargets(routing: unknown): Set<string> {
  const result = new Set<string>();
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) {
    return result;
  }
  for (const pools of Object.values(routing as Record<string, unknown>)) {
    if (!Array.isArray(pools)) continue;
    for (const pool of pools) {
      if (!pool || typeof pool !== 'object' || Array.isArray(pool)) continue;
      const targets = (pool as Record<string, unknown>).targets;
      if (!Array.isArray(targets)) continue;
      for (const target of targets) {
        if (typeof target === 'string' && target.trim()) {
          result.add(target.trim());
        }
      }
    }
  }
  return result;
}

export function resolveTargetToProviderKeys(target: string, providers: ProviderRuntimeKeyItem[]): string[] {
  const t = target.trim();
  if (!t) return [];
  const out = new Set<string>();
  for (const p of providers) {
    const providerKey = textOf(p.providerKey).trim();
    if (!providerKey) continue;
    if (providerKey === t) out.add(providerKey);
    if (!t.includes('.') && providerKey.startsWith(`${t}.`)) out.add(providerKey);
    if (!t.includes('.') && providerKey.endsWith(`.${t}`)) out.add(providerKey);
  }
  return Array.from(out);
}

export function resolveRoutedProviderKeys(targets: Set<string>, providers: ProviderRuntimeKeyItem[]): Set<string> {
  const out = new Set<string>();
  for (const target of targets) {
    for (const key of resolveTargetToProviderKeys(target, providers)) {
      out.add(key);
    }
  }
  return out;
}

export function statusClass(status: string): string {
  const v = status.toLowerCase();
  if (v === 'valid' || v === 'ok' || v === 'connected') return 'ok';
  if (v === 'expired' || v === 'invalid' || v === 'error' || v === 'disconnected') return 'err';
  return 'warn';
}

export function AppNotice({ children }: { children: React.ReactNode }) {
  return <div className="notice">{children}</div>;
}

export function LogBox({ value }: { value: string }) {
  return <div className="log mono">{value || '—'}</div>;
}

export function SectionHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <>
      <p className="card-title">{title}</p>
      {sub ? <p className="card-sub">{sub}</p> : null}
    </>
  );
}

function AdminAuthPanel({
  authStatus,
  authHint,
  adminPassword,
  oldPassword,
  newPassword,
  setAdminPassword,
  setOldPassword,
  setNewPassword,
  setupPassword,
  login,
  logout,
  changePassword,
  refreshStatus
}: {
  authStatus: AuthStatus;
  authHint: string;
  adminPassword: string;
  oldPassword: string;
  newPassword: string;
  setAdminPassword: (value: string) => void;
  setOldPassword: (value: string) => void;
  setNewPassword: (value: string) => void;
  setupPassword: () => Promise<void>;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  changePassword: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}) {
  return (
    <div className="panel">
      <SectionHeader
        title={authStatus.hasPassword ? 'Admin Login' : 'Admin Setup'}
        sub={
          authStatus.hasPassword
            ? 'Authenticate before opening provider, routing, or control pages.'
            : 'Set the daemon admin password first. Setup is allowed only for local trusted access.'
        }
      />
      <div className="row" style={{ marginBottom: 8 }}>
        <label htmlFor="admin-password">password</label>
        <input
          id="admin-password"
          type="password"
          value={adminPassword}
          onChange={(e) => setAdminPassword(e.target.value)}
          style={{ minWidth: 280, flex: 1 }}
          placeholder={
            authStatus.authRequired
              ? (authStatus.hasPassword ? 'enter admin password' : 'set admin password (8+ chars)')
              : 'auth disabled for loopback bind host'
          }
          disabled={!authStatus.authRequired}
        />
        {!authStatus.authRequired ? (
          <button className="primary" disabled>
            Login Bypassed
          </button>
        ) : !authStatus.hasPassword ? (
          <button className="primary" onClick={() => void setupPassword()}>
            Setup
          </button>
        ) : (
          <button className="primary" onClick={() => void login()}>
            Login
          </button>
        )}
        <button onClick={() => void logout()} disabled={!authStatus.authRequired || !authStatus.authenticated}>
          Logout
        </button>
        <span className="pill mono">{authHint}</span>
      </div>
      <div className="row">
        <label htmlFor="old-pass">old</label>
        <input
          id="old-pass"
          type="password"
          value={oldPassword}
          onChange={(e) => setOldPassword(e.target.value)}
          style={{ minWidth: 140 }}
          placeholder="old"
          disabled={!authStatus.authRequired}
        />
        <label htmlFor="new-pass">new</label>
        <input
          id="new-pass"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          style={{ minWidth: 140 }}
          placeholder="new"
          disabled={!authStatus.authRequired}
        />
        <button className="primary" onClick={() => void changePassword()} disabled={!authStatus.authRequired || !authStatus.authenticated}>
          Change Password
        </button>
        <button onClick={() => void refreshStatus()}>Refresh Status</button>
      </div>
    </div>
  );
}

export function App() {
  const [mainTab, setMainTab] = useState<MainTab>('providers');
  const [opsTab, setOpsTab] = useState<OpsTab>('stats');
  const [densityMode, setDensityMode] = useState<DensityMode>(() => {
    const cached = readSessionValue('routecodex:webui:density').trim().toLowerCase();
    return cached === 'comfortable' ? 'comfortable' : 'compact';
  });
  const [viewEpoch, setViewEpoch] = useState(0);

  const [serverVersion, setServerVersion] = useState('version: —');
  const [serverId, setServerId] = useState('serverId: —');
  const [serverStatus, setServerStatus] = useState('disconnected');

  const [authStatus, setAuthStatus] = useState<AuthStatus>({ authRequired: true, hasPassword: false, authenticated: false });
  const [authHint, setAuthHint] = useState('auth: checking...');
  const [authEpoch, setAuthEpoch] = useState(0);

  const [adminPassword, setAdminPassword] = useState('');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const [apiKey, setApiKey] = useState(() => readSessionValue('routecodex:apikey'));

  const [toast, setToast] = useState<{ message: string; kind: 'ok' | 'err' } | null>(null);

  const showToast = (message: string, kind: 'ok' | 'err' = 'err') => {
    setToast({ message, kind });
    setTimeout(() => {
      setToast((prev) => (prev?.message === message ? null : prev));
    }, 3200);
  };

  const refreshAdminAuthStatus = async () => {
    try {
      const status = await apiFetch<{ ok: boolean; authRequired?: boolean; hasPassword?: boolean; authenticated?: boolean }>('/daemon/auth/status');
      const authRequired = status?.authRequired !== false;
      const next: AuthStatus = {
        authRequired,
        hasPassword: authRequired ? Boolean(status?.hasPassword) : false,
        authenticated: authRequired ? Boolean(status?.authenticated) : true
      };
      setAuthStatus(next);
      if (!next.authRequired) setAuthHint('auth bypass (loopback bind)');
      else if (!next.hasPassword) setAuthHint('setup required (localhost only)');
      else if (!next.authenticated) setAuthHint('login required');
      else setAuthHint('authenticated');
      return next;
    } catch (error) {
      setAuthHint(error instanceof Error ? error.message : String(error));
      setAuthStatus({ authRequired: true, hasPassword: false, authenticated: false });
      return { authRequired: true, hasPassword: false, authenticated: false };
    }
  };

  const refreshStatus = async () => {
    try {
      const health = await fetch('/health');
      if (health.ok) {
        const data = await health.json().catch(() => null);
        setServerVersion(`version: ${data?.version || '—'}`);
      } else {
        setServerVersion('version: —');
      }
    } catch {
      setServerVersion('version: —');
    }

    try {
      const out = await apiFetch<{ serverId?: string }>('/daemon/status');
      setServerId(`serverId: ${out?.serverId || '—'}`);
      setServerStatus('connected');
    } catch {
      setServerId('serverId: —');
      setServerStatus('disconnected');
    }
  };

  useEffect(() => {
    void (async () => {
      await refreshAdminAuthStatus();
      await refreshStatus();
    })();
  }, []);

  const afterAuthMutate = async (okMessage: string) => {
    showToast(okMessage, 'ok');
    setAdminPassword('');
    setOldPassword('');
    setNewPassword('');
    await refreshAdminAuthStatus();
    await refreshStatus();
    setAuthEpoch((v) => v + 1);
  };

  const setupPassword = async () => {
    try {
      await apiFetch('/daemon/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: adminPassword })
      });
      await afterAuthMutate('Password set and logged in.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  };

  const login = async () => {
    try {
      await apiFetch('/daemon/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: adminPassword })
      });
      await afterAuthMutate('Logged in.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  };

  const logout = async () => {
    try {
      await apiFetch('/daemon/auth/logout', { method: 'POST' });
      await afterAuthMutate('Logged out.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  };

  const changePassword = async () => {
    try {
      await apiFetch('/daemon/auth/change', {
        method: 'POST',
        body: JSON.stringify({ oldPassword, newPassword })
      });
      await afterAuthMutate('Password changed.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  };

  const persistApiKey = (value: string) => {
    setApiKey(value);
    writeSessionValue('routecodex:apikey', value);
    showToast(value ? 'API key saved in session.' : 'API key cleared.', 'ok');
  };

  const setDensity = (mode: DensityMode) => {
    setDensityMode(mode);
    writeSessionValue('routecodex:webui:density', mode);
  };

  const activeViewLabel = useMemo(() => {
    if (mainTab === 'providers') return 'Providers / Catalog';
    if (mainTab === 'routing') {
      return 'Routing / Routing Groups';
    }
    if (opsTab === 'stats') {
      return 'Ops / Stats';
    }
    if (opsTab === 'control') {
      return 'Ops / Control Plane';
    }
    return 'Ops / Control Plane';
  }, [mainTab, opsTab]);

  const refreshCurrentView = () => {
    setViewEpoch((v) => v + 1);
    showToast(`Refreshed: ${activeViewLabel}`, 'ok');
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = String(target?.tagName || '').toLowerCase();
      const editing = tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable;
      if (editing) {
        return;
      }
      if ((event.key === 'r' || event.key === 'R') && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        refreshCurrentView();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeViewLabel]);

  const effectiveEpoch = authEpoch + viewEpoch;
  const shouldGateAdmin = authStatus.authRequired && !authStatus.authenticated;

  return (
    <div className={`app density-${densityMode}`}>
      <div className="topbar">
        <div>
          <h1 className="title">RouteCodex WebUI V2</h1>
          <p className="subtitle">Task-oriented workspace: Providers / Routing / Ops</p>
        </div>
        <div className="pill-row">
          <span className={`pill ${statusClass(serverStatus)}`}>status: {serverStatus}</span>
          <span className="pill mono">{serverVersion}</span>
          <span className="pill mono">{serverId}</span>
        </div>
      </div>

      {shouldGateAdmin ? (
        <div style={{ marginTop: 10 }}>
          <AppNotice>Admin authentication is required before opening any daemon management page.</AppNotice>
          <div className="auth-grid">
            <AdminAuthPanel
              authStatus={authStatus}
              authHint={authHint}
              adminPassword={adminPassword}
              oldPassword={oldPassword}
              newPassword={newPassword}
              setAdminPassword={setAdminPassword}
              setOldPassword={setOldPassword}
              setNewPassword={setNewPassword}
              setupPassword={setupPassword}
              login={login}
              logout={logout}
              changePassword={changePassword}
              refreshStatus={refreshStatus}
            />
          </div>
        </div>
      ) : (
        <>
          {authStatus.authRequired ? (
            <div className="auth-grid">
              <AdminAuthPanel
                authStatus={authStatus}
                authHint={authHint}
                adminPassword={adminPassword}
                oldPassword={oldPassword}
                newPassword={newPassword}
                setAdminPassword={setAdminPassword}
                setOldPassword={setOldPassword}
                setNewPassword={setNewPassword}
                setupPassword={setupPassword}
                login={login}
                logout={logout}
                changePassword={changePassword}
                refreshStatus={refreshStatus}
              />

              <div className="panel">
                <SectionHeader title="Server API Key" sub="Optional for /v1/* tests on Provider page." />
                <div className="row">
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="x-api-key"
                    style={{ minWidth: 180, flex: 1 }}
                  />
                  <button className="primary" onClick={() => persistApiKey(apiKey)}>
                    Save
                  </button>
                  <button onClick={() => persistApiKey('')}>Clear</button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="nav panel" style={{ padding: 10 }}>
            <button className={mainTab === 'providers' ? 'active' : ''} onClick={() => setMainTab('providers')}>
              Providers
            </button>
            <button className={mainTab === 'routing' ? 'active' : ''} onClick={() => setMainTab('routing')}>
              Routing
            </button>
            <button className={mainTab === 'ops' ? 'active' : ''} onClick={() => setMainTab('ops')}>
              Ops
            </button>
            {mainTab === 'providers' ? (
              <button className="active">
                Provider Catalog
              </button>
            ) : null}
            {mainTab === 'routing' ? (
              <button className="active">
                Routing Groups
              </button>
            ) : null}
            {mainTab === 'ops' ? (
              <>
                <button className={opsTab === 'stats' ? 'active' : ''} onClick={() => setOpsTab('stats')}>
                  Stats
                </button>
                <button className={opsTab === 'control' ? 'active' : ''} onClick={() => setOpsTab('control')}>
                  Control Plane
                </button>
              </>
            ) : null}
          </div>

          <div className="actionbar panel" style={{ padding: 10 }}>
            <div className="row">
              <span className="pill mono">view: {activeViewLabel}</span>
              <span className="pill mono">density: {densityMode}</span>
            </div>
            <div className="row">
              <button className="primary" onClick={refreshCurrentView}>
                Refresh View (R)
              </button>
              <button className={densityMode === 'compact' ? 'active' : ''} onClick={() => setDensity('compact')}>
                Compact
              </button>
              <button className={densityMode === 'comfortable' ? 'active' : ''} onClick={() => setDensity('comfortable')}>
                Comfortable
              </button>
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            {mainTab === 'providers' ? (
              <ProviderPage authenticated={authStatus.authenticated} authEpoch={effectiveEpoch} apiKey={apiKey} onToast={showToast} />
            ) : null}
            {mainTab === 'routing' ? (
              <RoutingPage authenticated={authStatus.authenticated} authEpoch={effectiveEpoch} onToast={showToast} />
            ) : null}
            {mainTab === 'ops' && opsTab === 'stats'
              ? <StatsPage authenticated={authStatus.authenticated} authEpoch={effectiveEpoch} onToast={showToast} />
              : null}
            {mainTab === 'ops' && opsTab === 'control'
              ? <ControlPage authenticated={authStatus.authenticated} authEpoch={effectiveEpoch} onToast={showToast} />
              : null}
          </div>
        </>
      )}

      {toast ? (
        <div
          className={`panel mono ${toast.kind === 'ok' ? 'pill ok' : 'pill err'}`}
          style={{ position: 'fixed', right: 14, bottom: 14, zIndex: 999, maxWidth: 480 }}
        >
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}

export function ProviderPage({
  authenticated,
  authEpoch,
  apiKey,
  onToast
}: {
  authenticated: boolean;
  authEpoch: number;
  apiKey: string;
  onToast: (message: string, kind?: 'ok' | 'err') => void;
}) {
  type ProviderSource = 'v1' | 'v2';
  type ProviderCatalogItem = ProviderSummary & {
    source: ProviderSource;
    family?: string;
    protocol?: string;
    version?: string;
    defaultModels?: string[];
    credentialsRef?: string;
  };
  type RuntimeView = {
    providerKey?: string;
    runtimeKey?: string;
    family?: string;
    protocol?: string;
    series?: string;
    enabled?: boolean;
  };

  const emptyDraft = (): Record<string, unknown> => ({
    id: '',
    enabled: true,
    type: 'openai',
    providerType: 'openai',
    baseURL: '',
    compatibilityProfile: 'compat:passthrough',
    auth: { type: 'apikey', apiKey: 'authfile-REPLACE_ME' },
    models: {}
  });

  const toRecord = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  };

  const readModels = (provider: Record<string, unknown>): string[] => {
    const models = provider.models;
    if (!models || typeof models !== 'object' || Array.isArray(models)) return [];
    return Object.keys(models as Record<string, unknown>).sort((a, b) => a.localeCompare(b));
  };

  const readAuthRef = (authNode: Record<string, unknown>): string => {
    const apiKeyRef = textOf(authNode.apiKey).trim();
    if (apiKeyRef) return apiKeyRef;
    const secretRef = textOf(authNode.secretRef).trim();
    if (secretRef) return secretRef;
    return '';
  };

  const [providers, setProviders] = useState<ProviderCatalogItem[]>([]);
  const [providerSourceById, setProviderSourceById] = useState<Record<string, ProviderSource>>({});
  const [providerVersionById, setProviderVersionById] = useState<Record<string, string>>({});
  const [runtimeViews, setRuntimeViews] = useState<RuntimeView[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');

  const [selectedId, setSelectedId] = useState('');
  const [providerIdInput, setProviderIdInput] = useState('');
  const [draft, setDraft] = useState<Record<string, unknown>>(emptyDraft());
  const [log, setLog] = useState('');

  const [authAlias, setAuthAlias] = useState('default');
  const [authValue, setAuthValue] = useState('');
  const [secretRef, setSecretRef] = useState('');
  const [newModelId, setNewModelId] = useState('');

  const modelKeys = useMemo(() => readModels(draft), [draft]);

  const refreshProviders = async () => {
    if (!authenticated) return;
    setLoading(true);
    try {
      const [v2Raw, v1Raw, runtimesRaw] = await Promise.all([
        apiFetch<unknown>('/config/providers/v2').catch(() => [] as unknown[]),
        apiFetch<{ providers?: ProviderSummary[] }>('/config/providers').catch(() => ({ providers: [] })),
        apiFetch<RuntimeView[]>('/providers/runtimes').catch(() => [] as RuntimeView[])
      ]);

      const nextSourceById: Record<string, ProviderSource> = {};
      const nextVersionById: Record<string, string> = {};
      const merged: ProviderCatalogItem[] = [];

      const v2List = Array.isArray(v2Raw) ? v2Raw : [];
      for (const item of v2List) {
        const rec = toRecord(item);
        const id = textOf(rec.id).trim();
        if (!id) continue;
        const defaultModels = Array.isArray(rec.defaultModels)
          ? rec.defaultModels.map((m) => textOf(m).trim()).filter(Boolean)
          : [];
        merged.push({
          id,
          source: 'v2',
          enabled: rec.enabled !== false,
          type: textOf(rec.family || rec.protocol || '—'),
          modelCount: defaultModels.length,
          modelsPreview: defaultModels.slice(0, 6),
          authType: textOf(rec.credentialsRef ? 'authfile' : 'managed'),
          family: textOf(rec.family || ''),
          protocol: textOf(rec.protocol || ''),
          version: textOf(rec.version || '2.0.0'),
          defaultModels,
          credentialsRef: textOf(rec.credentialsRef || '')
        });
        nextSourceById[id] = 'v2';
        nextVersionById[id] = textOf(rec.version || '2.0.0');
      }

      const v1List = Array.isArray(v1Raw?.providers) ? v1Raw.providers : [];
      for (const item of v1List) {
        const id = textOf(item.id).trim();
        if (!id || nextSourceById[id]) continue;
        merged.push({
          ...item,
          id,
          source: 'v1'
        });
        nextSourceById[id] = 'v1';
      }

      merged.sort((a, b) => textOf(a.id).localeCompare(textOf(b.id)));
      setProviders(merged);
      setProviderSourceById(nextSourceById);
      setProviderVersionById(nextVersionById);
      setRuntimeViews(Array.isArray(runtimesRaw) ? runtimesRaw : []);
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshProviders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, authEpoch]);

  const loadProvider = async (id: string) => {
    if (!id || !authenticated) return;
    const source = providerSourceById[id] || 'v1';
    const endpoint = source === 'v2' ? `/config/providers/v2/${encodeURIComponent(id)}` : `/config/providers/${encodeURIComponent(id)}`;
    try {
      const out = await apiFetch<{ provider?: Record<string, unknown> }>(endpoint);
      setSelectedId(id);
      setProviderIdInput(id);
      setDraft(toRecord(out?.provider));
      setLog(`Loaded provider ${id} (${source}).`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Load failed: ${msg}`);
      onToast(msg);
    }
  };

  const resetNewProvider = () => {
    setSelectedId('');
    setProviderIdInput('');
    setDraft(emptyDraft());
    setLog('New provider template loaded.');
  };

  const saveProvider = async () => {
    if (!authenticated) return;
    const id = providerIdInput.trim();
    if (!id) {
      onToast('provider id is required');
      return;
    }
    const source = providerSourceById[id] || 'v2';
    try {
      const provider: Record<string, unknown> = structuredClone(draft);
      provider.id = id;
      if (!provider.models || typeof provider.models !== 'object' || Array.isArray(provider.models)) {
        provider.models = {};
      }

      let out: { path?: string } | null = null;
      if (source === 'v2') {
        out = await apiFetch<{ path?: string }>('/config/providers/v2', {
          method: 'POST',
          body: JSON.stringify({
            providerId: id,
            version: providerVersionById[id] || '2.0.0',
            provider
          })
        });
      } else {
        out = await apiFetch<{ path?: string }>(`/config/providers/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: JSON.stringify({ provider })
        });
      }

      setSelectedId(id);
      setLog(`Saved provider ${id} (${source}). path=${out?.path || '—'}\nRestart required to apply runtime.`);
      onToast('Provider saved.', 'ok');
      await refreshProviders();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Save failed: ${msg}`);
      onToast(msg);
    }
  };

  const deleteProvider = async (idRaw?: string) => {
    if (!authenticated) return;
    const id = (idRaw || providerIdInput).trim();
    if (!id) {
      onToast('provider id is required');
      return;
    }
    const source = providerSourceById[id] || 'v2';
    if (!window.confirm(`Delete provider "${id}"?`)) return;
    try {
      const out = source === 'v2'
        ? await apiFetch<{ path?: string }>(`/config/providers/v2/${encodeURIComponent(id)}`, { method: 'DELETE' })
        : await apiFetch<{ path?: string }>(`/config/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setLog(`Deleted provider ${id} (${source}). path=${out?.path || '—'}\nRestart required to apply runtime.`);
      onToast('Provider deleted.', 'ok');
      if (selectedId === id) resetNewProvider();
      await refreshProviders();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Delete failed: ${msg}`);
      onToast(msg);
    }
  };

  const testProvider = async (idRaw?: string) => {
    if (!authenticated) return;
    const id = (idRaw || providerIdInput).trim();
    if (!id) {
      onToast('provider id is required');
      return;
    }
    const source = providerSourceById[id] || 'v2';
    const endpoint = source === 'v2' ? `/config/providers/v2/${encodeURIComponent(id)}` : `/config/providers/${encodeURIComponent(id)}`;
    try {
      const detail = await apiFetch<{ provider?: Record<string, unknown> }>(endpoint);
      const provider = detail?.provider || {};
      const modelsNode = provider.models;
      const models = modelsNode && typeof modelsNode === 'object' && !Array.isArray(modelsNode)
        ? Object.keys(modelsNode as Record<string, unknown>)
        : [];
      const firstModel = models[0] || textOf((provider as Record<string, unknown>).defaultModel || '').trim();
      if (!firstModel) throw new Error('No models configured for this provider.');

      const payload = {
        model: `${id}.${firstModel}`,
        input: [{ role: 'user', content: 'ping' }],
        stream: false
      };
      const headers = new Headers({ 'content-type': 'application/json' });
      if (apiKey.trim()) {
        headers.set('x-api-key', apiKey.trim());
      }

      const started = Date.now();
      const res = await fetch('/v1/responses', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
      const text = await res.text();
      const elapsed = Date.now() - started;

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} (${elapsed}ms): ${text}`);
      }

      let outputText = '';
      try {
        const json = text ? JSON.parse(text) : null;
        outputText = textOf((json as { output_text?: unknown } | null)?.output_text || '').trim();
      } catch {
        outputText = '';
      }

      setLog(`Test OK (${elapsed}ms) model=${id}.${firstModel}\n${outputText || '(ok)'}`);
      onToast('Provider test passed.', 'ok');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Test failed: ${msg}`);
      onToast(msg);
    }
  };

  const createApiKeyCredential = async () => {
    if (!authenticated) return;
    const provider = providerIdInput.trim();
    const alias = authAlias.trim() || 'default';
    const key = authValue.trim();
    if (!provider) {
      onToast('provider id is required before creating authfile');
      return;
    }
    if (!key) {
      onToast('api key is required');
      return;
    }
    try {
      const out = await apiFetch<{ secretRef?: string }>('/daemon/credentials/apikey', {
        method: 'POST',
        body: JSON.stringify({ provider, alias, apiKey: key })
      });
      const ref = textOf(out?.secretRef).trim();
      setSecretRef(ref);
      setLog(`Authfile created: ${ref || '—'}`);
      onToast('Authfile created.', 'ok');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Create authfile failed: ${msg}`);
      onToast(msg);
    }
  };

  const patchDraft = (mutator: (obj: Record<string, unknown>) => void) => {
    const next = structuredClone(draft);
    mutator(next);
    setDraft(next);
  };

  const applySecretRefToProvider = () => {
    if (!secretRef.trim()) {
      onToast('No secretRef yet. Create authfile first.');
      return;
    }
    patchDraft((obj) => {
      const auth = obj.auth;
      if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
        obj.auth = { type: 'apikey', apiKey: secretRef.trim() };
        return;
      }
      (auth as Record<string, unknown>).type = 'apikey';
      (auth as Record<string, unknown>).apiKey = secretRef.trim();
    });
    onToast('secretRef applied to provider auth.', 'ok');
  };

  const addModel = () => {
    const modelId = newModelId.trim();
    if (!modelId) return;
    patchDraft((obj) => {
      const existing = obj.models;
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        obj.models = { [modelId]: {} };
        return;
      }
      (existing as Record<string, unknown>)[modelId] = (existing as Record<string, unknown>)[modelId] || {};
    });
    setNewModelId('');
  };

  const removeModel = (modelId: string) => {
    patchDraft((obj) => {
      const models = obj.models;
      if (!models || typeof models !== 'object' || Array.isArray(models)) return;
      delete (models as Record<string, unknown>)[modelId];
    });
  };

  const shownProviders = providers
    .filter((item) => {
      const q = filter.trim().toLowerCase();
      if (!q) return true;
      return (
        textOf(item.id).toLowerCase().includes(q) ||
        textOf(item.type).toLowerCase().includes(q) ||
        textOf(item.baseURL).toLowerCase().includes(q) ||
        textOf(item.family).toLowerCase().includes(q) ||
        textOf(item.protocol).toLowerCase().includes(q)
      );
    })
    .sort((a, b) => textOf(a.id).localeCompare(textOf(b.id)));

  return (
    <div className="grid grid-3">
      <div className="panel">
        <SectionHeader
          title="Provider Pool"
          sub="Provider directory registry view (v2 first) with runtime mapping and quick actions."
        />
        <div className="row" style={{ marginBottom: 8 }}>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter provider/family/protocol/baseURL"
            style={{ flex: 1, minWidth: 180 }}
          />
          <button className="primary" onClick={() => void refreshProviders()} disabled={!authenticated || loading}>
            Refresh
          </button>
          <button onClick={resetNewProvider}>New</button>
        </div>

        <div className="grid">
          {shownProviders.map((item) => {
            const source = item.source;
            const runtimes = runtimeViews.filter((rt) => {
              const providerKey = textOf(rt.providerKey).trim();
              const runtimeKey = textOf(rt.runtimeKey).trim();
              const id = textOf(item.id).trim();
              return providerKey === id || providerKey.startsWith(`${id}.`) || runtimeKey === id || runtimeKey.startsWith(`${id}.`);
            });
            const modelPreview = Array.isArray(item.modelsPreview) && item.modelsPreview.length ? item.modelsPreview : item.defaultModels || [];

            return (
              <div key={`${source}.${item.id}`} className="panel" style={{ padding: 10 }}>
                <div className="row" style={{ marginBottom: 8, justifyContent: 'space-between' }}>
                  <div className="row">
                    <span className="pill mono">{item.id}</span>
                    <span className="pill">{source.toUpperCase()}</span>
                    <span className={`pill ${item.enabled === false ? 'err' : 'ok'}`}>{item.enabled === false ? 'disabled' : 'enabled'}</span>
                    {item.protocol ? <span className="pill mono">{item.protocol}</span> : null}
                    {item.family ? <span className="pill mono">{item.family}</span> : null}
                  </div>
                  <div className="row">
                    <button onClick={() => void loadProvider(textOf(item.id))}>Edit</button>
                    <button onClick={() => void testProvider(textOf(item.id))} disabled={!authenticated}>
                      Test
                    </button>
                    <button className="danger" onClick={() => void deleteProvider(textOf(item.id))} disabled={!authenticated}>
                      Delete
                    </button>
                  </div>
                </div>

                <div className="row" style={{ marginBottom: 6 }}>
                  <span className="muted">models:</span>
                  {modelPreview.length
                    ? modelPreview.slice(0, 8).map((modelId) => (
                      <span key={`${item.id}.${modelId}`} className="pill mono">
                        {modelId}
                      </span>
                    ))
                    : <span className="muted">none</span>}
                </div>

                <div className="row">
                  <span className="muted">auth:</span>
                  <span className="pill mono">{textOf(item.authType || item.credentialsRef || '—')}</span>
                  <span className="pill mono">models={formatInt(item.modelCount || 0)}</span>
                  <span className="pill mono">runtimes={formatInt(runtimes.length)}</span>
                </div>
              </div>
            );
          })}
          {!shownProviders.length ? <AppNotice>No providers found in registry/config.</AppNotice> : null}
        </div>
      </div>

      <div className="panel">
        <SectionHeader title="Provider Editor" sub="Structured provider form (no raw JSON)." />
        <div className="row" style={{ marginBottom: 8 }}>
          <label htmlFor="provider-id">provider id</label>
          <input
            id="provider-id"
            value={providerIdInput}
            onChange={(e) => setProviderIdInput(e.target.value)}
            style={{ minWidth: 220, flex: 1 }}
            placeholder="e.g. openai / glm / custom"
          />
          <button onClick={() => void loadProvider(providerIdInput)} disabled={!authenticated}>
            Load
          </button>
          <button className="primary" onClick={() => void saveProvider()} disabled={!authenticated}>
            Save
          </button>
          <button className="danger" onClick={() => void deleteProvider()} disabled={!authenticated}>
            Delete
          </button>
        </div>

        <div className="grid">
          <div className="row">
            <label>type</label>
            <input
              value={textOf(draft.type || '')}
              onChange={(e) => patchDraft((obj) => { obj.type = e.target.value; })}
              style={{ minWidth: 180 }}
            />
            <label>providerType</label>
            <input
              value={textOf(draft.providerType || '')}
              onChange={(e) => patchDraft((obj) => { obj.providerType = e.target.value; })}
              style={{ minWidth: 180 }}
            />
            <label>
              <input
                type="checkbox"
                checked={draft.enabled !== false}
                onChange={(e) => patchDraft((obj) => { obj.enabled = e.target.checked; })}
              />{' '}
              enabled
            </label>
          </div>

          <div className="row">
            <label>baseURL</label>
            <input
              value={textOf(draft.baseURL || '')}
              onChange={(e) => patchDraft((obj) => { obj.baseURL = e.target.value; })}
              style={{ minWidth: 260, flex: 1 }}
            />
          </div>

          <div className="row">
            <label>compatibility</label>
            <input
              value={textOf(draft.compatibilityProfile || '')}
              onChange={(e) => patchDraft((obj) => { obj.compatibilityProfile = e.target.value; })}
              style={{ minWidth: 260, flex: 1 }}
            />
          </div>

          <div className="row">
            <label>auth.type</label>
            <input
              value={textOf(toRecord(draft.auth).type || '')}
              onChange={(e) =>
                patchDraft((obj) => {
                  const auth = toRecord(obj.auth);
                  auth.type = e.target.value;
                  obj.auth = auth;
                })
              }
              style={{ minWidth: 180 }}
            />
            <label>auth ref</label>
            <input
              value={readAuthRef(toRecord(draft.auth))}
              onChange={(e) =>
                patchDraft((obj) => {
                  const auth = toRecord(obj.auth);
                  auth.apiKey = e.target.value;
                  obj.auth = auth;
                })
              }
              style={{ minWidth: 280, flex: 1 }}
              placeholder="api key / authfile-* / env-ref"
            />
          </div>
        </div>
      </div>

      <div className="panel">
        <SectionHeader title="Models + Test + Authfile" sub="Model registry + authfile helper (no raw JSON)." />

        <div className="row" style={{ marginBottom: 8 }}>
          <input
            value={newModelId}
            onChange={(e) => setNewModelId(e.target.value)}
            placeholder="new model id"
            style={{ minWidth: 180, flex: 1 }}
          />
          <button onClick={addModel}>Add Model</button>
        </div>

        <div className="table-wrap short" style={{ marginBottom: 10 }}>
          <table className="table">
            <thead>
              <tr>
                <th>model</th>
                <th>action</th>
              </tr>
            </thead>
            <tbody>
              {modelKeys.map((modelId) => (
                <tr key={modelId}>
                  <td className="mono">{modelId}</td>
                  <td>
                    <button className="danger" onClick={() => removeModel(modelId)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
              {!modelKeys.length ? (
                <tr>
                  <td colSpan={2} className="muted">
                    No models in provider registry.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="row" style={{ marginBottom: 8 }}>
          <button className="primary" onClick={() => void testProvider()} disabled={!authenticated}>
            Test Provider (/v1/responses)
          </button>
        </div>

        <AppNotice>
          Test request uses model pattern <span className="mono">providerId.modelId</span> from provider registry and sends a simple <span className="mono">ping</span>.
        </AppNotice>

        <SectionHeader title="API key authfile" sub="Create authfile and apply secretRef to provider.auth.apiKey" />
        <div className="row" style={{ marginBottom: 8 }}>
          <label>alias</label>
          <input value={authAlias} onChange={(e) => setAuthAlias(e.target.value)} style={{ width: 120 }} />
          <label>apiKey</label>
          <input
            type="password"
            value={authValue}
            onChange={(e) => setAuthValue(e.target.value)}
            style={{ minWidth: 160, flex: 1 }}
          />
        </div>
        <div className="row" style={{ marginBottom: 8 }}>
          <button onClick={() => void createApiKeyCredential()} disabled={!authenticated}>
            Create authfile
          </button>
          <span className="mono">secretRef: {secretRef || '—'}</span>
          <button onClick={applySecretRefToProvider} disabled={!secretRef}>
            Apply to provider
          </button>
        </div>

        <LogBox value={log} />
      </div>
    </div>
  );
}

export function RoutingPage({
  authenticated,
  authEpoch,
  onToast
}: {
  authenticated: boolean;
  authEpoch: number;
  onToast: (message: string, kind?: 'ok' | 'err') => void;
}) {
  const toRecord = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  };

  const [sources, setSources] = useState<RoutingSource[]>([]);
  const [sourcePath, setSourcePath] = useState('');

  const [location, setLocation] = useState('virtualrouter.routing');
  const [groups, setGroups] = useState<Record<string, unknown>>({});
  const [activeGroupId, setActiveGroupId] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [policyDraft, setPolicyDraft] = useState<Record<string, unknown>>({ routing: {} });
  const [newGroupId, setNewGroupId] = useState('');
  const [log, setLog] = useState('');

  const [newRouteName, setNewRouteName] = useState('');
  const [poolRoute, setPoolRoute] = useState('');
  const [poolTargetsText, setPoolTargetsText] = useState('');

  const currentSourceQuery = () => {
    const path = sourcePath.trim();
    return path ? `?path=${encodeURIComponent(path)}` : '';
  };

  const normalizedPolicy = useMemo(() => {
    const p = toRecord(policyDraft);
    const routing = toRecord(p.routing);
    return {
      ...p,
      routing
    };
  }, [policyDraft]);

  const routeRows = useMemo(() => {
    const rows: Array<{
      name: string;
      pools: Array<{
        id: string;
        mode: string;
        priority: string;
        backup: boolean;
        targets: string[];
      }>;
    }> = [];
    const routing = toRecord(normalizedPolicy.routing);
    for (const [name, poolsNode] of Object.entries(routing)) {
      const pools = Array.isArray(poolsNode) ? poolsNode : [];
      const parsedPools = pools
        .map((poolNode, idx) => {
          const rec = toRecord(poolNode);
          const targets = Array.isArray(rec.targets)
            ? rec.targets.map((item) => textOf(item).trim()).filter(Boolean)
            : [];
          return {
            id: textOf(rec.id || `${name}-${idx + 1}`),
            mode: textOf(rec.mode || '—'),
            priority: textOf(rec.priority || '—'),
            backup: rec.backup === true,
            targets
          };
        })
        .filter((p) => p.targets.length > 0 || p.mode !== '—' || p.priority !== '—' || p.backup);
      rows.push({ name, pools: parsedPools });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }, [normalizedPolicy]);

  useEffect(() => {
    if (routeRows.length === 0) {
      setPoolRoute('');
      return;
    }
    if (!poolRoute || !routeRows.some((row) => row.name === poolRoute)) {
      setPoolRoute(routeRows[0].name);
    }
  }, [routeRows, poolRoute]);

  const refreshSources = async () => {
    if (!authenticated) return;
    try {
      const out = await apiFetch<{ sources?: RoutingSource[]; activePath?: string }>('/config/routing/sources');
      const list = Array.isArray(out?.sources) ? out.sources : [];
      setSources(list);
      const active = textOf(out?.activePath).trim();
      if (!sourcePath.trim()) {
        setSourcePath(active || textOf(list[0]?.path || '').trim());
      } else {
        const hasCurrent = list.some((item) => textOf(item.path).trim() === sourcePath.trim());
        if (!hasCurrent) {
          setSourcePath(active || textOf(list[0]?.path || '').trim());
        }
      }
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error));
    }
  };

  const loadGroups = async (preferred?: string) => {
    if (!authenticated) return;
    try {
      const query = currentSourceQuery();
      const out = await apiFetch<{
        groups?: Record<string, unknown>;
        activeGroupId?: string;
        location?: string;
        path?: string;
      }>(`/config/routing/groups${query}`);

      const nextGroups = out?.groups && typeof out.groups === 'object' ? out.groups : {};
      setGroups(nextGroups as Record<string, unknown>);
      const active = textOf(out?.activeGroupId || '').trim();
      const ids = Object.keys(nextGroups || {}).sort((a, b) => a.localeCompare(b));
      const selected = preferred && ids.includes(preferred)
        ? preferred
        : selectedGroupId && ids.includes(selectedGroupId)
          ? selectedGroupId
          : active && ids.includes(active)
            ? active
            : ids[0] || '';
      setSelectedGroupId(selected);
      setActiveGroupId(active || selected);
      setLocation(textOf(out?.location || location || 'virtualrouter.routing'));

      const policy = toRecord((nextGroups as Record<string, unknown>)[selected]);
      setPolicyDraft(Object.keys(policy).length ? policy : { routing: {} });
      setLog(`Loaded groups from ${out?.path || sourcePath || '—'}\nselected=${selected || '—'} active=${active || '—'}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Load failed: ${msg}`);
      onToast(msg);
    }
  };

  useEffect(() => {
    void (async () => {
      await refreshSources();
      await loadGroups();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, authEpoch]);

  useEffect(() => {
    if (!authenticated) return;
    void loadGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcePath]);

  const selectGroup = (groupId: string) => {
    setSelectedGroupId(groupId);
    const next = toRecord(groups[groupId]);
    setPolicyDraft(Object.keys(next).length ? next : { routing: {} });
  };

  const saveGroup = async () => {
    if (!authenticated) return;
    const groupId = selectedGroupId.trim();
    if (!groupId) {
      onToast('No routing group selected.');
      return;
    }
    const routing = toRecord(normalizedPolicy.routing);
    if (!Object.keys(routing).length) {
      onToast('At least one route is required before save.');
      return;
    }

    try {
      const out = await apiFetch<{
        groups?: Record<string, unknown>;
        activeGroupId?: string;
        location?: string;
        path?: string;
      }>(`/config/routing/groups/${encodeURIComponent(groupId)}${currentSourceQuery()}`, {
        method: 'PUT',
        body: JSON.stringify({
          policy: normalizedPolicy,
          location,
          path: sourcePath || undefined
        })
      });
      setGroups((out?.groups || {}) as Record<string, unknown>);
      setActiveGroupId(textOf(out?.activeGroupId || activeGroupId).trim());
      setLocation(textOf(out?.location || location).trim());
      setLog(`Saved group ${groupId}. path=${out?.path || sourcePath || '—'}`);
      onToast('Routing group saved.', 'ok');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Save failed: ${msg}`);
      onToast(msg);
    }
  };

  const createGroup = async () => {
    if (!authenticated) return;
    const groupId = newGroupId.trim();
    if (!groupId) {
      onToast('new group id is required');
      return;
    }

    try {
      const out = await apiFetch<{
        groups?: Record<string, unknown>;
        activeGroupId?: string;
        location?: string;
        path?: string;
      }>(`/config/routing/groups/${encodeURIComponent(groupId)}${currentSourceQuery()}`, {
        method: 'PUT',
        body: JSON.stringify({
          policy: normalizedPolicy,
          location,
          path: sourcePath || undefined
        })
      });
      setGroups((out?.groups || {}) as Record<string, unknown>);
      setSelectedGroupId(groupId);
      setActiveGroupId(textOf(out?.activeGroupId || activeGroupId).trim());
      setLocation(textOf(out?.location || location).trim());
      setNewGroupId('');
      setLog(`Created/updated group ${groupId}. path=${out?.path || sourcePath || '—'}`);
      onToast('Routing group created.', 'ok');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Create failed: ${msg}`);
      onToast(msg);
    }
  };

  const deleteGroup = async () => {
    if (!authenticated) return;
    const groupId = selectedGroupId.trim();
    if (!groupId) {
      onToast('No routing group selected.');
      return;
    }
    if (!window.confirm(`Delete routing group "${groupId}"?`)) return;
    const queryBase = currentSourceQuery();
    const locationPart = location ? `${queryBase ? '&' : '?'}location=${encodeURIComponent(location)}` : '';
    try {
      const out = await apiFetch<{
        groups?: Record<string, unknown>;
        activeGroupId?: string;
        location?: string;
        path?: string;
      }>(`/config/routing/groups/${encodeURIComponent(groupId)}${queryBase}${locationPart}`, {
        method: 'DELETE'
      });
      const nextGroups = (out?.groups || {}) as Record<string, unknown>;
      const ids = Object.keys(nextGroups).sort((a, b) => a.localeCompare(b));
      const nextSelected = ids[0] || '';
      setGroups(nextGroups);
      setSelectedGroupId(nextSelected);
      setActiveGroupId(textOf(out?.activeGroupId || nextSelected).trim());
      setLocation(textOf(out?.location || location).trim());
      setPolicyDraft(toRecord(nextGroups[nextSelected] || { routing: {} }));
      setLog(`Deleted group ${groupId}.`);
      onToast('Routing group deleted.', 'ok');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Delete failed: ${msg}`);
      onToast(msg);
    }
  };

  const activateLocal = async () => {
    if (!authenticated) return;
    const groupId = selectedGroupId.trim();
    if (!groupId) {
      onToast('No routing group selected.');
      return;
    }
    if (!window.confirm(`Activate group "${groupId}" and reload local runtime?`)) return;
    try {
      const out = await apiFetch<{ activeGroupId?: string; groups?: Record<string, unknown>; path?: string }>(
        `/config/routing/groups/activate${currentSourceQuery()}`,
        {
          method: 'POST',
          body: JSON.stringify({ groupId, location, path: sourcePath || undefined })
        }
      );
      setGroups((out?.groups || {}) as Record<string, unknown>);
      setActiveGroupId(textOf(out?.activeGroupId || groupId).trim());
      setLog(`Activated local group ${groupId}. path=${out?.path || sourcePath || '—'}`);
      onToast('Routing group activated locally.', 'ok');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Activate local failed: ${msg}`);
      onToast(msg);
    }
  };

  const activateAll = async () => {
    if (!authenticated) return;
    const groupId = selectedGroupId.trim();
    if (!groupId) {
      onToast('No routing group selected.');
      return;
    }
    if (!window.confirm(`Activate group "${groupId}" and restart all local servers?`)) return;
    try {
      await apiFetch(`/config/routing/groups/activate${currentSourceQuery()}`, {
        method: 'POST',
        body: JSON.stringify({ groupId, location, path: sourcePath || undefined })
      });
      const out = await apiFetch('/daemon/control/mutate', {
        method: 'POST',
        body: JSON.stringify({ action: 'servers.restart' })
      });
      setLog(`Activated ${groupId} and sent restart-all.\n${prettyJson(out)}`);
      onToast('Restart-all requested.', 'ok');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Activate all failed: ${msg}`);
      onToast(msg);
    }
  };

  const addRoute = () => {
    const routeName = newRouteName.trim();
    if (!routeName) {
      onToast('route name is required');
      return;
    }
    setPolicyDraft((prev) => {
      const next = structuredClone(prev);
      const routing = toRecord(next.routing);
      if (!Array.isArray(routing[routeName])) {
        routing[routeName] = [];
      }
      next.routing = routing;
      return next;
    });
    setPoolRoute(routeName);
    setNewRouteName('');
  };

  const removeRoute = (routeName: string) => {
    setPolicyDraft((prev) => {
      const next = structuredClone(prev);
      const routing = toRecord(next.routing);
      delete routing[routeName];
      next.routing = routing;
      return next;
    });
  };

  const addPool = () => {
    const routeName = poolRoute.trim();
    if (!routeName) {
      onToast('select a route first');
      return;
    }
    const targets = poolTargetsText
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (!targets.length) {
      onToast('at least one target is required');
      return;
    }
    setPolicyDraft((prev) => {
      const next = structuredClone(prev);
      const routing = toRecord(next.routing);
      const pools = Array.isArray(routing[routeName]) ? [...(routing[routeName] as unknown[])] : [];
      pools.push({
        id: `${routeName}-${Date.now()}`,
        mode: 'round-robin',
        targets
      });
      routing[routeName] = pools;
      next.routing = routing;
      return next;
    });
    setPoolTargetsText('');
  };

  const removePool = (routeName: string, index: number) => {
    setPolicyDraft((prev) => {
      const next = structuredClone(prev);
      const routing = toRecord(next.routing);
      const pools = Array.isArray(routing[routeName]) ? [...(routing[routeName] as unknown[])] : [];
      pools.splice(index, 1);
      routing[routeName] = pools;
      next.routing = routing;
      return next;
    });
  };

  const groupIds = Object.keys(groups || {}).sort((a, b) => a.localeCompare(b));

  return (
    <div className="grid grid-wide-left">
      <div className="panel">
        <SectionHeader title="Routing Management" sub="Readable route registry cards (route -> pool -> targets), no raw JSON." />

        <div className="row" style={{ marginBottom: 8 }}>
          <label>source</label>
          <select
            value={sourcePath}
            onChange={(e) => setSourcePath(e.target.value)}
            style={{ minWidth: 380, flex: 1 }}
          >
            {sources.map((source) => {
              const path = textOf(source.path).trim();
              const label = textOf(source.label || source.path || '—');
              const meta = `${textOf(source.kind || '')}${source.version ? ` v=${source.version}` : ''}${source.location ? ` (${source.location})` : ''}`;
              return (
                <option key={path || label} value={path}>
                  {label} {meta}
                </option>
              );
            })}
          </select>
          <button onClick={() => void refreshSources()} disabled={!authenticated}>
            Refresh Sources
          </button>
          <button className="primary" onClick={() => void loadGroups()} disabled={!authenticated}>
            Load
          </button>
        </div>

        <div className="row" style={{ marginBottom: 8 }}>
          <label>group</label>
          <select
            value={selectedGroupId}
            onChange={(e) => selectGroup(e.target.value)}
            style={{ width: 220 }}
          >
            {groupIds.map((id) => (
              <option key={id} value={id}>
                {id === activeGroupId ? `${id} (active)` : id}
              </option>
            ))}
          </select>
          <input
            value={newGroupId}
            onChange={(e) => setNewGroupId(e.target.value)}
            placeholder="new group id"
            style={{ width: 180 }}
          />
          <button onClick={() => void createGroup()} disabled={!authenticated}>
            Create/Copy Group
          </button>
          <button className="danger" onClick={() => void deleteGroup()} disabled={!authenticated}>
            Delete Group
          </button>
          <span className="pill mono">active: {activeGroupId || '—'}</span>
        </div>

        <div className="row" style={{ marginBottom: 8 }}>
          <button className="primary" onClick={() => void saveGroup()} disabled={!authenticated}>
            Save Group
          </button>
          <button className="warn" onClick={() => void activateLocal()} disabled={!authenticated}>
            Activate + Restart Local
          </button>
          <button className="warn" onClick={() => void activateAll()} disabled={!authenticated}>
            Activate + Restart All
          </button>
          <span className="pill mono">location: {location}</span>
        </div>

        <div className="panel" style={{ padding: 10, marginBottom: 8 }}>
          <SectionHeader title="Route Builder" sub="Add routes and pools with target list (comma/newline separated)." />
          <div className="row" style={{ marginBottom: 8 }}>
            <input
              value={newRouteName}
              onChange={(e) => setNewRouteName(e.target.value)}
              placeholder="route name (e.g. default / coding / tools)"
              style={{ minWidth: 260, flex: 1 }}
            />
            <button onClick={addRoute}>Add Route</button>
          </div>

          <div className="row">
            <select value={poolRoute} onChange={(e) => setPoolRoute(e.target.value)} style={{ minWidth: 220 }}>
              {routeRows.map((row) => (
                <option key={row.name} value={row.name}>
                  {row.name}
                </option>
              ))}
            </select>
            <input
              value={poolTargetsText}
              onChange={(e) => setPoolTargetsText(e.target.value)}
              placeholder="targets: provider.alias.model, provider.alias.model"
              style={{ minWidth: 340, flex: 1 }}
            />
            <button onClick={addPool}>Add Pool</button>
          </div>
        </div>

        <div className="grid">
          {routeRows.map((route) => (
            <div key={route.name} className="panel" style={{ padding: 10 }}>
              <div className="row" style={{ marginBottom: 8, justifyContent: 'space-between' }}>
                <div className="row">
                  <span className="pill mono">route: {route.name}</span>
                  <span className="pill mono">pools={route.pools.length}</span>
                </div>
                <button className="danger" onClick={() => removeRoute(route.name)}>
                  Remove Route
                </button>
              </div>

              {route.pools.length ? (
                <div className="table-wrap short">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>id</th>
                        <th>mode</th>
                        <th>priority</th>
                        <th>targets</th>
                        <th>action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {route.pools.map((poolItem, idx) => (
                        <tr key={`${route.name}.${poolItem.id}.${idx}`}>
                          <td className="mono">{poolItem.id}</td>
                          <td>{poolItem.mode}</td>
                          <td className="mono">{poolItem.priority}{poolItem.backup ? ' (backup)' : ''}</td>
                          <td>
                            <div className="row">
                              {poolItem.targets.map((target) => (
                                <span key={`${route.name}.${poolItem.id}.${target}`} className="pill mono">
                                  {target}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td>
                            <button className="danger" onClick={() => removePool(route.name, idx)}>
                              Remove Pool
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <AppNotice>No pools in this route.</AppNotice>
              )}
            </div>
          ))}
          {!routeRows.length ? <AppNotice>No routes configured for selected group.</AppNotice> : null}
        </div>
      </div>

      <div className="grid">
        <div className="panel">
          <SectionHeader title="Routing Log" sub="Operation output and API responses." />
          <LogBox value={log} />
        </div>
      </div>
    </div>
  );
}

export function StatsPage({
  authenticated,
  authEpoch,
  onToast
}: {
  authenticated: boolean;
  authEpoch: number;
  onToast: (message: string, kind?: 'ok' | 'err') => void;
}) {
  const [sessionRows, setSessionRows] = useState<StatsRow[]>([]);
  const [historicalRows, setHistoricalRows] = useState<StatsRow[]>([]);
  const [periods, setPeriods] = useState<{
    daily: PeriodStatsRow[];
    weekly: PeriodStatsRow[];
    monthly: PeriodStatsRow[];
  }>({ daily: [], weekly: [], monthly: [] });
  const [periodMode, setPeriodMode] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [totals, setTotals] = useState<any>(null);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const refresh = async () => {
    if (!authenticated) return;
    try {
      const out = await apiFetch<{
        session?: { totals?: StatsRow[] };
        historical?: { totals?: StatsRow[] };
        periods?: {
          daily?: PeriodStatsRow[];
          weekly?: PeriodStatsRow[];
          monthly?: PeriodStatsRow[];
        };
        totals?: any;
      }>(
        '/daemon/stats'
      );
      setSessionRows(Array.isArray(out?.session?.totals) ? out.session!.totals! : []);
      setHistoricalRows(Array.isArray(out?.historical?.totals) ? out.historical!.totals! : []);
      setPeriods({
        daily: Array.isArray(out?.periods?.daily) ? out.periods!.daily! : [],
        weekly: Array.isArray(out?.periods?.weekly) ? out.periods!.weekly! : [],
        monthly: Array.isArray(out?.periods?.monthly) ? out.periods!.monthly! : []
      });
      setTotals(out?.totals || null);
      setUpdatedAt(Date.now());
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, authEpoch]);

  useEffect(() => {
    if (!authenticated || !autoRefresh) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 2000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, autoRefresh]);

  const summarize = (rows: StatsRow[]) => {
    const byProvider = new Map<string, { req: number; err: number }>();
    const byRuntime = new Map<string, { req: number; err: number }>();
    const byModel = new Map<string, { req: number; err: number }>();
    let reqTotal = 0;
    let errTotal = 0;

    for (const row of rows) {
      const providerKey = textOf(row.providerKey).trim();
      if (!providerKey) continue;
      const req = Number(row.requestCount || 0);
      const err = Number(row.errorCount || 0);
      reqTotal += req;
      errTotal += err;

      const providerId = providerKey.split('.')[0] || providerKey;
      const runtime = providerKey.split('.').slice(0, 2).join('.') || providerKey;
      const model = textOf(row.model || '—') || '—';

      const p = byProvider.get(providerId) || { req: 0, err: 0 };
      p.req += req;
      p.err += err;
      byProvider.set(providerId, p);

      const rt = byRuntime.get(runtime) || { req: 0, err: 0 };
      rt.req += req;
      rt.err += err;
      byRuntime.set(runtime, rt);

      const m = byModel.get(model) || { req: 0, err: 0 };
      m.req += req;
      m.err += err;
      byModel.set(model, m);
    }

    return {
      reqTotal,
      errTotal,
      byProvider: Array.from(byProvider.entries()).sort((a, b) => b[1].req - a[1].req),
      byRuntime: Array.from(byRuntime.entries()).sort((a, b) => b[1].req - a[1].req),
      byModel: Array.from(byModel.entries()).sort((a, b) => b[1].req - a[1].req)
    };
  };

  const sessionSummary = summarize(sessionRows);
  const historicalSummary = summarize(historicalRows);

  const mergedTokenRows = useMemo(() => {
    const map = new Map<string, { providerKey: string; model: string; session?: StatsRow; historical?: StatsRow }>();
    const keyOf = (row: StatsRow) => `${textOf(row.providerKey)}|${textOf(row.model || '')}`;

    for (const row of sessionRows) {
      const key = keyOf(row);
      map.set(key, {
        providerKey: textOf(row.providerKey),
        model: textOf(row.model || ''),
        session: row,
        historical: map.get(key)?.historical
      });
    }

    for (const row of historicalRows) {
      const key = keyOf(row);
      map.set(key, {
        providerKey: textOf(row.providerKey),
        model: textOf(row.model || ''),
        session: map.get(key)?.session,
        historical: row
      });
    }

    return Array.from(map.values()).sort((a, b) => {
      const ak = `${a.providerKey}.${a.model}`;
      const bk = `${b.providerKey}.${b.model}`;
      return ak.localeCompare(bk);
    });
  }, [sessionRows, historicalRows]);

  const periodRows = useMemo(() => {
    const rows = periods[periodMode] || [];
    return rows
      .slice()
      .sort((a, b) => textOf(b.period).localeCompare(textOf(a.period)));
  }, [periods, periodMode]);

  return (
    <div className="grid">
      <div className="panel">
        <SectionHeader
          title="Stats Management"
          sub="Merged session/historical/token analytics in one page. Session stats reset on restart."
        />
        <div className="row" style={{ marginBottom: 8 }}>
          <button className="primary" onClick={() => void refresh()} disabled={!authenticated}>
            Refresh
          </button>
          <label>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} /> auto refresh (2s)
          </label>
          <span className="pill mono">updated: {updatedAt ? formatTs(updatedAt) : '—'}</span>
        </div>

        <div className="kpi-grid" style={{ marginBottom: 10 }}>
          <div className="kpi">
            <div className="v">{formatInt(sessionSummary.reqTotal)}</div>
            <div className="k">Session Requests</div>
          </div>
          <div className="kpi">
            <div className="v">{formatInt(sessionSummary.errTotal)}</div>
            <div className="k">Session Errors</div>
          </div>
          <div className="kpi">
            <div className="v">{formatInt(historicalSummary.reqTotal)}</div>
            <div className="k">Historical Requests</div>
          </div>
          <div className="kpi">
            <div className="v">{formatInt(historicalSummary.errTotal)}</div>
            <div className="k">Historical Errors</div>
          </div>
        </div>

        <div className="split">
          <div className="panel" style={{ padding: 10 }}>
            <SectionHeader title="Session" />
            <div className="table-wrap short">
              <table className="table">
                <thead>
                  <tr>
                    <th>provider</th>
                    <th>req</th>
                    <th>err</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionSummary.byProvider.map(([key, val]) => (
                    <tr key={`s-p-${key}`}>
                      <td className="mono">{key}</td>
                      <td className="mono">{formatInt(val.req)}</td>
                      <td className="mono">{formatInt(val.err)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-wrap short" style={{ marginTop: 8 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>runtime</th>
                    <th>req</th>
                    <th>err</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionSummary.byRuntime.map(([key, val]) => (
                    <tr key={`s-r-${key}`}>
                      <td className="mono">{key}</td>
                      <td className="mono">{formatInt(val.req)}</td>
                      <td className="mono">{formatInt(val.err)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel" style={{ padding: 10 }}>
            <SectionHeader title="Historical" />
            <div className="table-wrap short">
              <table className="table">
                <thead>
                  <tr>
                    <th>provider</th>
                    <th>req</th>
                    <th>err</th>
                  </tr>
                </thead>
                <tbody>
                  {historicalSummary.byProvider.map(([key, val]) => (
                    <tr key={`h-p-${key}`}>
                      <td className="mono">{key}</td>
                      <td className="mono">{formatInt(val.req)}</td>
                      <td className="mono">{formatInt(val.err)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-wrap short" style={{ marginTop: 8 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>runtime</th>
                    <th>req</th>
                    <th>err</th>
                  </tr>
                </thead>
                <tbody>
                  {historicalSummary.byRuntime.map(([key, val]) => (
                    <tr key={`h-r-${key}`}>
                      <td className="mono">{key}</td>
                      <td className="mono">{formatInt(val.req)}</td>
                      <td className="mono">{formatInt(val.err)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="panel" style={{ marginTop: 10, padding: 10 }}>
          <SectionHeader title="Token Usage (Session + Historical)" />
          <AppNotice>
            ALL(session): req={formatInt(totals?.session?.requestCount)} err={formatInt(totals?.session?.errorCount)} in/out/total=
            {formatInt(totals?.session?.totalPromptTokens)}/{formatInt(totals?.session?.totalCompletionTokens)}/
            {formatInt(totals?.session?.totalOutputTokens)}
            <br />
            ALL(historical): req={formatInt(totals?.historical?.requestCount)} err={formatInt(totals?.historical?.errorCount)} in/out/total=
            {formatInt(totals?.historical?.totalPromptTokens)}/{formatInt(totals?.historical?.totalCompletionTokens)}/
            {formatInt(totals?.historical?.totalOutputTokens)}
          </AppNotice>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>providerKey</th>
                  <th>model</th>
                  <th>session req/err</th>
                  <th>session in/out/total</th>
                  <th>historical req/err</th>
                  <th>historical in/out/total</th>
                </tr>
              </thead>
              <tbody>
                {mergedTokenRows.map((row) => (
                  <tr key={`${row.providerKey}.${row.model}`}>
                    <td className="mono">{row.providerKey}</td>
                    <td className="mono">{row.model || '—'}</td>
                    <td className="mono">
                      {row.session ? `${formatInt(row.session.requestCount)} / ${formatInt(row.session.errorCount)}` : '—'}
                    </td>
                    <td className="mono">
                      {row.session
                        ? `${formatInt(row.session.totalPromptTokens)}/${formatInt(row.session.totalCompletionTokens)}/${formatInt(
                            row.session.totalOutputTokens
                          )}`
                        : '—'}
                    </td>
                    <td className="mono">
                      {row.historical ? `${formatInt(row.historical.requestCount)} / ${formatInt(row.historical.errorCount)}` : '—'}
                    </td>
                    <td className="mono">
                      {row.historical
                        ? `${formatInt(row.historical.totalPromptTokens)}/${formatInt(row.historical.totalCompletionTokens)}/${formatInt(
                            row.historical.totalOutputTokens
                          )}`
                        : '—'}
                    </td>
                  </tr>
                ))}
                {!mergedTokenRows.length ? (
                  <tr>
                    <td colSpan={6} className="muted">
                      No token data.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel" style={{ marginTop: 10, padding: 10 }}>
          <SectionHeader title="Persistent History (Day / Week / Month)" />
          <div className="row" style={{ marginBottom: 8 }}>
            <button
              className={periodMode === 'daily' ? 'primary' : ''}
              onClick={() => setPeriodMode('daily')}
            >
              Daily
            </button>
            <button
              className={periodMode === 'weekly' ? 'primary' : ''}
              onClick={() => setPeriodMode('weekly')}
            >
              Weekly
            </button>
            <button
              className={periodMode === 'monthly' ? 'primary' : ''}
              onClick={() => setPeriodMode('monthly')}
            >
              Monthly
            </button>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>period</th>
                  <th>req/err</th>
                  <th>in/out/total</th>
                </tr>
              </thead>
              <tbody>
                {periodRows.map((row) => (
                  <tr key={`${periodMode}-${textOf(row.period)}`}>
                    <td className="mono">{textOf(row.period)}</td>
                    <td className="mono">
                      {formatInt(row.requestCount)} / {formatInt(row.errorCount)}
                    </td>
                    <td className="mono">
                      {formatInt(row.totalPromptTokens)}/{formatInt(row.totalCompletionTokens)}/{formatInt(row.totalOutputTokens)}
                    </td>
                  </tr>
                ))}
                {!periodRows.length ? (
                  <tr>
                    <td colSpan={3} className="muted">
                      No persisted period data.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}


export function AdvancedPage({
  authenticated,
  authEpoch,
  tab,
  onToast
}: {
  authenticated: boolean;
  authEpoch: number;
  tab: AdvancedTab;
  onToast: (message: string, kind?: 'ok' | 'err') => void;
}) {
  return <ControlPage authenticated={authenticated} authEpoch={authEpoch} onToast={onToast} />;
}

export function ControlPage({
  authenticated,
  authEpoch,
  onToast
}: {
  authenticated: boolean;
  authEpoch: number;
  onToast: (message: string, kind?: 'ok' | 'err') => void;
}) {
  const [snapshot, setSnapshot] = useState<any>(null);
  const [providerKey, setProviderKey] = useState('');
  const [mode, setMode] = useState<'cooldown' | 'blacklist'>('cooldown');
  const [duration, setDuration] = useState(60);
  const [log, setLog] = useState('');

  const refresh = async () => {
    if (!authenticated) return;
    try {
      const out = await apiFetch('/daemon/control/snapshot');
      setSnapshot(out);
      setLog('Control snapshot refreshed.');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Snapshot failed: ${msg}`);
      onToast(msg);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, authEpoch]);

  const mutate = async (action: string, payload: Record<string, unknown> = {}) => {
    if (!authenticated) return;
    try {
      const out = await apiFetch('/daemon/control/mutate', {
        method: 'POST',
        body: JSON.stringify({ action, ...payload })
      });
      setLog(`${action} success\n${prettyJson(out)}`);
      onToast(`${action} done.`, 'ok');
      await refresh();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`${action} failed: ${msg}`);
      onToast(msg);
    }
  };

  const servers = Array.isArray(snapshot?.servers) ? snapshot.servers : [];
  return (
    <div className="grid grid-wide-left">
      <div className="panel">
        <SectionHeader title="Control Plane" sub="Single entry for control snapshot and server restart operations." />
        <div className="row" style={{ marginBottom: 8 }}>
          <button className="primary" onClick={() => void refresh()} disabled={!authenticated}>
            Refresh
          </button>
          <button className="danger" onClick={() => void mutate('servers.restart')} disabled={!authenticated}>
            Restart All Servers
          </button>
        </div>

        <div className="table-wrap short" style={{ marginBottom: 8 }}>
          <table className="table">
            <thead>
              <tr>
                <th>port</th>
                <th>version</th>
                <th>ready</th>
                <th>pids</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((item: any) => (
                <tr key={textOf(item.port)}>
                  <td className="mono">{textOf(item.port || '—')}</td>
                  <td className="mono">{textOf(item.version || '—')}</td>
                  <td>{String(Boolean(item.ready))}</td>
                  <td className="mono">{Array.isArray(item.pids) ? item.pids.join(' ') : '—'}</td>
                </tr>
              ))}
              {!servers.length ? (
                <tr>
                  <td colSpan={4} className="muted">
                    No local servers discovered.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <SectionHeader title="Control Log" />
        <LogBox value={log} />
      </div>
    </div>
  );

}
