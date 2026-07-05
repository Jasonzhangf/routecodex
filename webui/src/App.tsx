import React, { useEffect, useMemo, useState } from 'react';

type MainTab = 'providers' | 'routing' | 'forwarders';
type DensityMode = 'compact' | 'comfortable';

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

export type ProviderRuntimeKeyItem = {
  providerKey?: string;
};

type ConfigProviderPickerItem = {
  id: string;
  targets: string[];
};

export type ConfigPortView = {
  port?: number | string;
  host?: string;
  mode?: string;
  routingPolicyGroup?: string;
  providerBinding?: string;
  protocolBehavior?: string;
  sameProtocolBehavior?: string;
};

export type ConfigForwarderView = {
  id: string;
  protocol: string;
  model: string;
  strategy: string;
  targets: string[];
};

function recordOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function summarizeForwarders(forwarders: unknown): ConfigForwarderView[] {
  return Object.entries(recordOf(forwarders))
    .filter(([id]) => id.startsWith('fwd.'))
    .map(([id, node]) => {
      const rec = recordOf(node);
      const targets = arrayOf(rec.targets)
        .map((target) => {
          const targetRec = recordOf(target);
          const providerId = textOf(targetRec.providerId || targetRec.provider || target).trim();
          const weight = textOf(targetRec.weight).trim();
          const priority = textOf(targetRec.priority).trim();
          const suffix = [weight ? `w=${weight}` : '', priority ? `p=${priority}` : ''].filter(Boolean).join(' ');
          return suffix ? `${providerId} (${suffix})` : providerId;
        })
        .filter(Boolean);
      return {
        id,
        protocol: textOf(rec.protocol || '—'),
        model: textOf(rec.model || rec.modelId || '—'),
        strategy: textOf(rec.strategy || rec.mode || rec.loadBalancing || 'priority'),
        targets
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function loadConfigEditorSnapshot(path?: string): Promise<{
  path?: string;
  ports?: ConfigPortView[];
  routingPolicyGroups?: Record<string, unknown>;
  forwarders?: Record<string, unknown>;
  activeRoutingPolicyGroup?: string;
}> {
  const query = path && path.trim() ? `?path=${encodeURIComponent(path.trim())}` : '';
  return apiFetch(`/config/editor${query}`);
}

function buildProviderPickerItems(v2Raw: unknown, v1Raw: unknown): ConfigProviderPickerItem[] {
  const byId = new Map<string, Set<string>>();
  const addTargets = (idRaw: unknown, modelsRaw: unknown) => {
    const id = textOf(idRaw).trim();
    if (!id) return;
    const models = Array.isArray(modelsRaw)
      ? modelsRaw.map((item) => textOf(item).trim()).filter(Boolean)
      : [];
    const bucket = byId.get(id) || new Set<string>();
    if (!models.length) {
      bucket.add(id);
    } else {
      for (const model of models) {
        bucket.add(`${id}.default.${model}`);
      }
    }
    byId.set(id, bucket);
  };

  for (const item of Array.isArray(v2Raw) ? v2Raw : []) {
    const rec = recordOf(item);
    addTargets(rec.id, rec.defaultModels);
  }
  const v1Providers = recordOf(v1Raw).providers;
  for (const item of Array.isArray(v1Providers) ? v1Providers : []) {
    const rec = recordOf(item);
    addTargets(rec.id, rec.modelsPreview);
  }

  return Array.from(byId.entries())
    .map(([id, targets]) => ({ id, targets: Array.from(targets).sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}


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
            ? 'Authenticate before opening provider and routing config pages.'
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
      return 'Routing / Ports + Groups';
    }
    if (mainTab === 'forwarders') return 'Forwarders / fwd.*';
    return 'Providers / Catalog';
  }, [mainTab]);

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
          <p className="subtitle">Config editor workspace: Providers / Routing / Forwarders</p>
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
            <button className={mainTab === 'forwarders' ? 'active' : ''} onClick={() => setMainTab('forwarders')}>
              Forwarders
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
            {mainTab === 'forwarders' ? (
              <button className="active">
                fwd.* Aggregation
              </button>
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
            {mainTab === 'forwarders' ? (
              <ForwardersPage authenticated={authStatus.authenticated} authEpoch={effectiveEpoch} onToast={showToast} />
            ) : null}
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
  const [providerBackups, setProviderBackups] = useState<Record<string, { source: ProviderSource; provider: Record<string, unknown> }>>({});
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

  const backupProvider = async (idRaw?: string) => {
    if (!authenticated) return;
    const id = (idRaw || providerIdInput).trim();
    if (!id) {
      onToast('provider id is required');
      return;
    }
    const source = providerSourceById[id] || 'v2';
    const endpoint = source === 'v2' ? `/config/providers/v2/${encodeURIComponent(id)}` : `/config/providers/${encodeURIComponent(id)}`;
    try {
      const out = await apiFetch<{ provider?: Record<string, unknown> }>(endpoint);
      const provider = structuredClone(toRecord(out?.provider));
      if (!Object.keys(provider).length) {
        throw new Error('provider backup source is empty');
      }
      setProviderBackups((prev) => ({
        ...prev,
        [id]: { source, provider }
      }));
      setLog(`Backed up provider ${id} (${source}) in browser session.`);
      onToast('Provider backup captured.', 'ok');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Backup failed: ${msg}`);
      onToast(msg);
    }
  };

  const restoreProvider = async (idRaw?: string) => {
    if (!authenticated) return;
    const id = (idRaw || providerIdInput).trim();
    if (!id) {
      onToast('provider id is required');
      return;
    }
    const backup = providerBackups[id];
    if (!backup) {
      onToast('No provider backup captured for this provider.');
      return;
    }
    if (!window.confirm(`Restore provider "${id}" from session backup?`)) return;
    try {
      const provider: Record<string, unknown> = structuredClone(backup.provider);
      provider.id = id;
      if (backup.source === 'v2') {
        await apiFetch<{ path?: string }>('/config/providers/v2', {
          method: 'POST',
          body: JSON.stringify({
            providerId: id,
            version: providerVersionById[id] || '2.0.0',
            provider
          })
        });
      } else {
        await apiFetch<{ path?: string }>(`/config/providers/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: JSON.stringify({ provider })
        });
      }
      setDraft(provider);
      setProviderIdInput(id);
      setSelectedId(id);
      setLog(`Restored provider ${id} (${backup.source}) from session backup.`);
      onToast('Provider restored from backup.', 'ok');
      await refreshProviders();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Restore failed: ${msg}`);
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
                    <button onClick={() => void backupProvider(textOf(item.id))} disabled={!authenticated}>
                      Backup
                    </button>
                    <button onClick={() => void restoreProvider(textOf(item.id))} disabled={!authenticated || !providerBackups[textOf(item.id)]}>
                      Restore
                    </button>
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
          <button onClick={() => void backupProvider()} disabled={!authenticated || !providerIdInput.trim()}>
            Backup
          </button>
          <button onClick={() => void restoreProvider()} disabled={!authenticated || !providerBackups[providerIdInput.trim()]}>
            Restore
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
            <label htmlFor="provider-base-url">baseURL</label>
            <input
              id="provider-base-url"
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
  const [ports, setPorts] = useState<ConfigPortView[]>([]);
  const [selectedPortKey, setSelectedPortKey] = useState('');
  const [providerPickerItems, setProviderPickerItems] = useState<ConfigProviderPickerItem[]>([]);
  const [groups, setGroups] = useState<Record<string, unknown>>({});
  const [activeGroupId, setActiveGroupId] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [policyDraft, setPolicyDraft] = useState<Record<string, unknown>>({ routing: {} });
  const [newGroupId, setNewGroupId] = useState('');
  const [log, setLog] = useState('');

  const [newPortNumber, setNewPortNumber] = useState('');
  const [newPortGroup, setNewPortGroup] = useState('');
  const [newPortProvider, setNewPortProvider] = useState('');
  const [newPortSameProtocol, setNewPortSameProtocol] = useState('direct');
  const [newRouteName, setNewRouteName] = useState('');
  const [poolRoute, setPoolRoute] = useState('');
  const [poolTargetsText, setPoolTargetsText] = useState('');

  const makePortKey = (port: ConfigPortView, index: number) =>
    `${textOf(port.port || index)}:${textOf(port.routingPolicyGroup || port.providerBinding || port.mode || '')}`;

  const currentSourceQuery = () => {
    const path = sourcePath.trim();
    return path ? `?path=${encodeURIComponent(path)}` : '';
  };

  const loadConfigStructure = async () => {
    if (!authenticated) return;
    try {
      const out = await loadConfigEditorSnapshot(sourcePath);
      const nextPorts = Array.isArray(out?.ports) ? out.ports : [];
      setPorts(nextPorts);
      const loadedPath = textOf(out?.path || '').trim();
      if (loadedPath && !sourcePath.trim()) setSourcePath(loadedPath);
      const current = selectedPortKey.trim();
      const keys = nextPorts.map(makePortKey);
      if (!current || !keys.includes(current)) {
        setSelectedPortKey(keys[0] || '');
      }
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error));
    }
  };

  const refreshProviderPicker = async () => {
    if (!authenticated) return;
    try {
      const [v2Raw, v1Raw] = await Promise.all([
        apiFetch<unknown>('/config/providers/v2').catch(() => [] as unknown[]),
        apiFetch<unknown>('/config/providers').catch(() => ({ providers: [] }))
      ]);
      setProviderPickerItems(buildProviderPickerItems(v2Raw, v1Raw));
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error));
    }
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
      await loadConfigStructure();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Load failed: ${msg}`);
      onToast(msg);
    }
  };

  useEffect(() => {
    void (async () => {
      await refreshSources();
      await refreshProviderPicker();
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

  const savePorts = async (nextPorts: ConfigPortView[], successMessage: string, preferredKey?: string) => {
    const out = await apiFetch<{
      path?: string;
      ports?: ConfigPortView[];
    }>(`/config/editor/ports${currentSourceQuery()}`, {
      method: 'PUT',
      body: JSON.stringify({
        path: sourcePath || undefined,
        ports: nextPorts
      })
    });
    const savedPorts = Array.isArray(out?.ports) ? out.ports : nextPorts;
    setPorts(savedPorts);
    const savedPath = textOf(out?.path || '').trim();
    if (savedPath) setSourcePath(savedPath);
    const keys = savedPorts.map(makePortKey);
    setSelectedPortKey(preferredKey && keys.includes(preferredKey) ? preferredKey : keys[0] || '');
    setLog(`${successMessage} path=${out?.path || sourcePath || '—'}`);
    onToast(successMessage, 'ok');
  };

  const createPortTab = async () => {
    if (!authenticated) return;
    const portNumber = Number(newPortNumber);
    if (!Number.isInteger(portNumber) || portNumber <= 0 || portNumber > 65535) {
      onToast('port must be a TCP port number');
      return;
    }
    if (ports.some((item) => Number(item.port) === portNumber)) {
      onToast('port already exists');
      return;
    }
    const groupId = newPortGroup.trim() || selectedGroupId.trim() || activeGroupId.trim() || 'default';
    const nextPort: ConfigPortView = {
      port: portNumber,
      host: '0.0.0.0',
      mode: 'router',
      routingPolicyGroup: groupId,
      sameProtocolBehavior: newPortSameProtocol || 'direct'
    };
    if (newPortProvider.trim()) {
      nextPort.providerBinding = newPortProvider.trim();
    }
    const nextPorts = [...ports, nextPort];
    try {
      await savePorts(nextPorts, 'Port tab saved.', makePortKey(nextPort, nextPorts.length - 1));
      setNewPortNumber('');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Port save failed: ${msg}`);
      onToast(msg);
    }
  };

  const updateSelectedPortGroup = async (groupId: string) => {
    if (!authenticated || !selectedPort) return;
    const selectedIndex = portTabs.findIndex((item) => item.key === selectedPort.key);
    if (selectedIndex < 0) return;
    const nextPorts = ports.map((port, index) => (
      index === selectedIndex ? { ...port, routingPolicyGroup: groupId } : port
    ));
    const nextKey = makePortKey(nextPorts[selectedIndex], selectedIndex);
    try {
      await savePorts(nextPorts, 'Port routing group saved.', nextKey);
      if (groups[groupId]) selectGroup(groupId);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Port group save failed: ${msg}`);
      onToast(msg);
    }
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
  const portTabs = ports.map((port, index) => ({
    key: makePortKey(port, index),
    port,
    label: textOf(port.port || `#${index + 1}`),
    groupId: textOf(port.routingPolicyGroup || '').trim()
  }));
  const selectedPort = portTabs.find((item) => item.key === selectedPortKey) || portTabs[0];
  const providerTargetOptions = providerPickerItems.flatMap((item) => item.targets.map((target) => ({ providerId: item.id, target })));

  return (
    <div className="grid grid-wide-left">
      <div className="panel">
        <SectionHeader title="Routing Management" sub="Readable route registry cards (route -> pool -> targets), no raw JSON." />

        <div className="panel" style={{ padding: 10, marginBottom: 8 }}>
          <SectionHeader title="Port Routing Tabs" sub="One config tab per httpserver.ports[] entry." />
          <div className="row" style={{ marginBottom: 8 }}>
            {portTabs.map((item) => (
              <button
                key={item.key}
                className={selectedPort?.key === item.key ? 'active' : ''}
                onClick={() => {
                  setSelectedPortKey(item.key);
                  if (item.groupId && groups[item.groupId]) selectGroup(item.groupId);
                }}
              >
                {item.label}
              </button>
            ))}
            {!portTabs.length ? <span className="muted">No httpserver.ports[] entries loaded.</span> : null}
          </div>
          {selectedPort ? (
            <>
              <div className="row">
                <span className="pill mono">port: {textOf(selectedPort.port.port || '—')}</span>
                <span className="pill mono">mode: {textOf(selectedPort.port.mode || '—')}</span>
                <span className="pill mono">group: {textOf(selectedPort.port.routingPolicyGroup || '—')}</span>
                <span className="pill mono">provider: {textOf(selectedPort.port.providerBinding || '—')}</span>
                <span className="pill mono">same-protocol: {textOf(selectedPort.port.sameProtocolBehavior || '—')}</span>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <label htmlFor="port-routing-group">port group</label>
                <select
                  id="port-routing-group"
                  value={textOf(selectedPort.port.routingPolicyGroup || '')}
                  onChange={(e) => void updateSelectedPortGroup(e.target.value)}
                  style={{ minWidth: 180 }}
                >
                  {groupIds.map((id) => (
                    <option key={id} value={id}>{id}</option>
                  ))}
                </select>
              </div>
            </>
          ) : null}
          <div className="row" style={{ marginTop: 8 }}>
            <input
              aria-label="new port"
              value={newPortNumber}
              onChange={(e) => setNewPortNumber(e.target.value)}
              placeholder="new port"
              style={{ width: 120 }}
            />
            <select aria-label="new port routing group" value={newPortGroup} onChange={(e) => setNewPortGroup(e.target.value)} style={{ minWidth: 180 }}>
              <option value="">selected/default group</option>
              {groupIds.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
            <select aria-label="new port provider binding" value={newPortProvider} onChange={(e) => setNewPortProvider(e.target.value)} style={{ minWidth: 180 }}>
              <option value="">provider binding optional</option>
              {providerPickerItems.map((item) => (
                <option key={item.id} value={item.id}>{item.id}</option>
              ))}
            </select>
            <select aria-label="new port same protocol" value={newPortSameProtocol} onChange={(e) => setNewPortSameProtocol(e.target.value)} style={{ minWidth: 150 }}>
              <option value="direct">direct</option>
              <option value="relay">relay</option>
            </select>
            <button onClick={() => void createPortTab()} disabled={!authenticated}>
              Add Port Tab
            </button>
          </div>
        </div>

        <div className="row" style={{ marginBottom: 8 }}>
          <label htmlFor="routing-source">source</label>
          <select
            id="routing-source"
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
          <label htmlFor="routing-group">group</label>
          <select
            id="routing-group"
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
            Activate Local
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
            <select
              aria-label="provider target picker"
              value=""
              onChange={(e) => {
                const target = e.target.value;
                if (!target) return;
                setPoolTargetsText((prev) => prev.trim() ? `${prev.trim()}, ${target}` : target);
              }}
              style={{ minWidth: 260 }}
            >
              <option value="">choose existing provider target</option>
              {providerTargetOptions.map((item) => (
                <option key={item.target} value={item.target}>
                  {item.target}
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

export function ForwardersPage({
  authenticated,
  authEpoch,
  onToast
}: {
  authenticated: boolean;
  authEpoch: number;
  onToast: (message: string, kind?: 'ok' | 'err') => void;
}) {
  const [path, setPath] = useState('');
  const [forwarders, setForwarders] = useState<ConfigForwarderView[]>([]);
  const [forwarderRaw, setForwarderRaw] = useState<Record<string, unknown>>({});
  const [draftId, setDraftId] = useState('fwd.gpt-5.5');
  const [draftModel, setDraftModel] = useState('gpt-5.5');
  const [draftProtocol, setDraftProtocol] = useState('openai-responses');
  const [draftStrategy, setDraftStrategy] = useState('priority');
  const [draftTargetsText, setDraftTargetsText] = useState('demo:100');
  const [log, setLog] = useState('');

  const refreshForwarders = async () => {
    if (!authenticated) return;
    try {
      const out = await loadConfigEditorSnapshot(path);
      const raw = recordOf(out?.forwarders || {});
      const next = summarizeForwarders(raw);
      setForwarders(next);
      setForwarderRaw(raw);
      setPath(textOf(out?.path || path).trim());
      setLog(`Loaded ${next.length} fwd.* aggregations from ${out?.path || path || 'active config'}.`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Load forwarders failed: ${msg}`);
      onToast(msg);
    }
  };

  useEffect(() => {
    void refreshForwarders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, authEpoch]);

  const loadForwarderDraft = (item: ConfigForwarderView) => {
    const raw = recordOf(forwarderRaw[item.id]);
    const targetText = arrayOf(raw.targets)
      .map((target, index) => {
        const rec = recordOf(target);
        const providerId = textOf(rec.providerId || rec.provider || target).trim();
        const weight = textOf(rec.weight).trim();
        const priority = textOf(rec.priority).trim();
        const value = weight || priority || (item.strategy === 'priority' ? String((index + 1) * 100) : '1');
        return value ? `${providerId}:${value}` : providerId;
      })
      .filter(Boolean)
      .join('\n');
    setDraftId(item.id);
    setDraftModel(item.model === '—' ? '' : item.model);
    setDraftProtocol(item.protocol === '—' ? '' : item.protocol);
    setDraftStrategy(item.strategy || 'priority');
    setDraftTargetsText(targetText);
  };

  const buildDraftForwarder = (): Record<string, unknown> | null => {
    const id = draftId.trim();
    const model = draftModel.trim();
    const protocol = draftProtocol.trim();
    const strategy = draftStrategy.trim() || 'priority';
    if (!id.startsWith('fwd.')) {
      onToast('forwarder id must start with fwd.');
      return null;
    }
    if (!model) {
      onToast('forwarder model is required');
      return null;
    }
    const targets = draftTargetsText
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item, index) => {
        const [providerIdRaw, valueRaw] = item.split(':');
        const providerId = providerIdRaw.trim();
        const numericValue = Number(valueRaw || (strategy === 'priority' ? (index + 1) * 100 : 1));
        const target: Record<string, unknown> = { providerId };
        if (strategy === 'weighted') {
          target.weight = Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 1;
        } else if (strategy === 'priority') {
          target.priority = Number.isFinite(numericValue) && numericValue > 0 ? numericValue : (index + 1) * 100;
        }
        return target;
      });
    if (!targets.length || targets.some((target) => !textOf(target.providerId).trim())) {
      onToast('at least one forwarder target is required');
      return null;
    }
    return {
      protocol,
      model,
      strategy,
      targets
    };
  };

  const saveForwarder = async () => {
    if (!authenticated) return;
    const id = draftId.trim();
    const draft = buildDraftForwarder();
    if (!draft) return;
    const nextForwarders = {
      ...forwarderRaw,
      [id]: draft
    };
    try {
      const out = await apiFetch<{ path?: string; forwarders?: Record<string, unknown> }>(
        `/config/editor/forwarders${path.trim() ? `?path=${encodeURIComponent(path.trim())}` : ''}`,
        {
          method: 'PUT',
          body: JSON.stringify({ path: path || undefined, forwarders: nextForwarders })
        }
      );
      const raw = recordOf(out?.forwarders || nextForwarders);
      const next = summarizeForwarders(raw);
      setForwarderRaw(raw);
      setForwarders(next);
      setPath(textOf(out?.path || path).trim());
      setLog(`Forwarder saved. path=${out?.path || path || '—'}`);
      onToast('Forwarder saved.', 'ok');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Save forwarder failed: ${msg}`);
      onToast(msg);
    }
  };

  return (
    <div className="grid grid-wide-left">
      <div className="panel">
        <SectionHeader title="Forwarder Aggregation" sub="Config-only fwd.* aggregation view; runtime selection stays in Virtual Router." />
        <div className="row" style={{ marginBottom: 8 }}>
          <label htmlFor="forwarder-config-path">config</label>
          <input
            id="forwarder-config-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="active config path"
            style={{ minWidth: 380, flex: 1 }}
          />
          <button className="primary" onClick={() => void refreshForwarders()} disabled={!authenticated}>
            Load Forwarders
          </button>
        </div>

        <div className="panel" style={{ padding: 10, marginBottom: 8 }}>
          <SectionHeader title="Forwarder Editor" sub="Edit config shape only; runtime policy remains in Virtual Router." />
          <div className="row" style={{ marginBottom: 8 }}>
            <input
              aria-label="forwarder id"
              value={draftId}
              onChange={(e) => setDraftId(e.target.value)}
              placeholder="fwd.model"
              style={{ minWidth: 180 }}
            />
            <input
              aria-label="forwarder model"
              value={draftModel}
              onChange={(e) => setDraftModel(e.target.value)}
              placeholder="model"
              style={{ minWidth: 160 }}
            />
            <input
              aria-label="forwarder protocol"
              value={draftProtocol}
              onChange={(e) => setDraftProtocol(e.target.value)}
              placeholder="protocol"
              style={{ minWidth: 180 }}
            />
            <select
              aria-label="forwarder strategy"
              value={draftStrategy}
              onChange={(e) => setDraftStrategy(e.target.value)}
              style={{ minWidth: 150 }}
            >
              <option value="priority">priority</option>
              <option value="weighted">weighted</option>
              <option value="roundrobin">roundrobin</option>
            </select>
          </div>
          <div className="row">
            <textarea
              aria-label="forwarder targets"
              value={draftTargetsText}
              onChange={(e) => setDraftTargetsText(e.target.value)}
              placeholder="providerId:value, one per line"
              style={{ minWidth: 420, minHeight: 76, flex: 1 }}
            />
            <button className="primary" onClick={() => void saveForwarder()} disabled={!authenticated}>
              Save Forwarder
            </button>
          </div>
        </div>

        <div className="grid">
          {forwarders.map((item) => (
            <div key={item.id} className="panel" style={{ padding: 10 }}>
              <div className="row" style={{ marginBottom: 8 }}>
                <span className="pill mono">{item.id}</span>
                <span className="pill mono">model: {item.model}</span>
                <span className="pill mono">protocol: {item.protocol}</span>
                <span className="pill mono">strategy: {item.strategy}</span>
              </div>
              <div className="row">
                <span className="muted">targets:</span>
                {item.targets.map((target) => (
                  <span key={`${item.id}.${target}`} className="pill mono">
                    {target}
                  </span>
                ))}
                {!item.targets.length ? <span className="muted">none</span> : null}
                <button onClick={() => loadForwarderDraft(item)}>Edit</button>
              </div>
            </div>
          ))}
          {!forwarders.length ? <AppNotice>No fwd.* forwarders found in current config.</AppNotice> : null}
        </div>
      </div>

      <div className="panel">
        <SectionHeader title="Forwarder Log" sub="Config editor output for fwd.* aggregation." />
        <LogBox value={log} />
      </div>
    </div>
  );
}
