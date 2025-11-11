import type { ParsedResult } from './loaders.js';

export interface BuildOptions {
  keyDimension?: 'perKey' | 'runtime' | 'explicit';
}

export interface CanonicalLike {
  providers: Record<string, any>;
  keyVault: Record<string, Record<string, any>>;
  pipelines: Array<{ id: string; modules: any; authRef?: any; settings?: any }>;
  routing: Record<string, string[]>;
  routeMeta: Record<string, { providerId: string; modelId: string; keyId?: string | null }>;
  httpserver?: { port?: number; host?: string };
  modules?: { httpserver?: { enabled?: boolean; config?: { port?: number; host?: string } } };
  _metadata: Record<string, any>;
}

function aliasBaseUrl(obj: any) {
  if (!obj) return;
  if (obj.baseURL && !obj.baseUrl) obj.baseUrl = obj.baseURL;
}

export function buildCanonical(system: ParsedResult, user: ParsedResult, options: BuildOptions = {}): CanonicalLike {
  if (!system.ok) { throw new Error(`System config invalid: ${(system.errors||[]).join('; ')}`); }
  if (!user.ok) { throw new Error(`User config invalid: ${(user.errors||[]).join('; ')}`); }
  const u = user.data || {};
  const vr = (u.virtualrouter || {}) as any;
  const providersIn = (vr.providers || {}) as Record<string, any>;

  const providers: Record<string, any> = {};
  for (const [pid, p] of Object.entries(providersIn)) {
    const cp = JSON.parse(JSON.stringify(p));
    aliasBaseUrl(cp);
    providers[pid] = cp;
  }

  // Build keyVault from user auth + keyMappings
  const keyVault: Record<string, Record<string, any>> = {};
  for (const [pid, prov] of Object.entries(providers)) {
    const auth = (prov as any).auth;
    if (auth && typeof auth === 'object') {
      keyVault[pid] = keyVault[pid] || {};
      if (String(auth.type || '').toLowerCase() === 'apikey') {
        keyVault[pid]['key1'] = { type: 'apikey', value: String((auth as any).apiKey || ''), enabled: true };
      } else if (String(auth.type || '').toLowerCase() === 'oauth') {
        keyVault[pid]['key1'] = {
          type: 'oauth',
          oauth: {
            grant: (auth as any).grant,
            clientId: (auth as any).clientId,
            clientSecret: (auth as any).clientSecret,
            tokenUrl: (auth as any).tokenUrl,
            scopes: Array.isArray((auth as any).scopes) ? (auth as any).scopes : undefined
          },
          enabled: true
        };
      }
    }
  }
  // keyMappings.global → inject into keyVault (global scope, not provider-specific)
  try {
    const km = (vr.keyMappings || {}) as any;
    const globalMap = km.global && typeof km.global === 'object' ? (km.global as Record<string, string>) : {};
    if (Object.keys(globalMap).length) {
      // Put under a pseudo provider "global" unless provider-specific is desired.
      const pid = 'global';
      keyVault[pid] = keyVault[pid] || {};
      for (const [keyId, value] of Object.entries(globalMap)) {
        keyVault[pid][keyId] = { type: 'apikey', value: String(value), enabled: true };
      }
    }
    const provMap = km.providers && typeof km.providers === 'object' ? (km.providers as Record<string, Record<string, string>>) : {};
    for (const [pid, mp] of Object.entries(provMap)) {
      keyVault[pid] = keyVault[pid] || {};
      for (const [keyId, value] of Object.entries(mp || {})) {
        keyVault[pid][keyId] = { type: 'apikey', value: String(value), enabled: true };
      }
    }
  } catch { /* ignore keyMappings errors */ }

  // Pipelines: prefer explicit user.pipelines; otherwise empty for now (no inference)
  const pipelines: Array<{ id: string; modules: any; authRef?: any; settings?: any }> = Array.isArray(u.pipelines) ? [...u.pipelines] : [];

  // Routing: copy categories, default to []
  const routing = Object.create(null) as Record<string, string[]>;
  const cats = ['default','coding','longcontext','tools','thinking','vision','websearch','background'];
  const ur = (vr.routing || {}) as Record<string, any>;
  for (const c of cats) {
    const arr = Array.isArray(ur[c]) ? ur[c] : [];
    routing[c] = arr.map(String);
  }

  // routeMeta: derive from pipelines ids; pattern <providerId>.<modelId>[__<keyId>]
  const routeMeta: Record<string, { providerId: string; modelId: string; keyId?: string | null }> = {};
  const parseId = (id: string): { providerId: string; modelId: string; keyId?: string | null } | null => {
    if (!id) return null;
    const parts = String(id).split('__');
    const base = parts[0];
    const keyId = parts.length > 1 ? parts.slice(1).join('__') : null;
    const dot = base.indexOf('.');
    if (dot <= 0 || dot >= base.length - 1) return null;
    const providerId = base.slice(0, dot);
    const modelId = base.slice(dot + 1);
    return { providerId, modelId, keyId };
  };
  const pushMeta = (id: string) => {
    const p = parseId(id);
    if (!p) return;
    routeMeta[id] = { providerId: p.providerId, modelId: p.modelId, keyId: p.keyId || null };
  };

  // PerKey expansion for pipelines when keyDimension=perKey and id has no __keyId
  const keyMode = (options.keyDimension || 'perKey');
  const expanded: typeof pipelines = [];
  const seenIds = new Set<string>();
  const addPl = (pl: any) => { if (!seenIds.has(pl.id)) { expanded.push(pl); seenIds.add(pl.id); pushMeta(pl.id); } };
  for (const pl of pipelines) {
    const id = String(pl.id || '');
    const parsed = parseId(id);
    if (!parsed) { addPl(pl); continue; }
    const { providerId, modelId, keyId } = parsed;
    if (keyMode === 'perKey' && !keyId) {
      const vault = keyVault[providerId] || {};
      const keyIds = Object.keys(vault).filter(k => vault[k]?.enabled !== false);
      if (keyIds.length === 0) {
        throw new Error(`perKey mode: provider '${providerId}' has no enabled keys for pipeline '${id}'`);
      }
      for (const kid of keyIds.sort()) {
        const newId = `${providerId}.${modelId}__${kid}`;
        const newPl = JSON.parse(JSON.stringify(pl));
        newPl.id = newId;
        newPl.authRef = { mode: 'perKey', providerId, keyId: kid };
        addPl(newPl);
      }
    } else {
      if (keyMode === 'perKey' && keyId) {
        // ensure authRef present
        if (!pl.authRef) pl.authRef = { mode: 'perKey', providerId, keyId };
      }
      addPl(pl);
    }
  }

  // Routing expansion for perKey mode: <pid>.<mid> → all keys
  if (keyMode === 'perKey') {
    for (const [cat, arr] of Object.entries(routing)) {
      const out: string[] = [];
      for (const rid of arr) {
        const parsed = parseId(rid);
        if (!parsed) { out.push(rid); continue; }
        const { providerId, modelId, keyId } = parsed;
        if (!keyId) {
          const vault = keyVault[providerId] || {};
          const keyIds = Object.keys(vault).filter(k => vault[k]?.enabled !== false);
          if (keyIds.length === 0) {
            throw new Error(`perKey routing: provider '${providerId}' has no enabled keys for route '${rid}' in category '${cat}'`);
          }
          for (const kid of keyIds.sort()) {
            out.push(`${providerId}.${modelId}__${kid}`);
          }
        } else {
          out.push(rid);
        }
      }
      // de-dup and stable sort
      routing[cat] = Array.from(new Set(out)).sort();
    }
  }

  // Project optional httpserver (no guessing)
  const httpUser = (u as any).httpserver || {};
  const httpserver: { port?: number; host?: string } | undefined = (
    (typeof httpUser.port === 'number' && httpUser.port > 0) || (typeof httpUser.host === 'string' && httpUser.host.trim())
  ) ? { port: httpUser.port, host: httpUser.host } : undefined;
  const modules: any = {};
  if (httpserver) {
    modules.httpserver = { enabled: true, config: { ...httpserver } };
  }

  return {
    providers,
    keyVault,
    pipelines: expanded,
    routing,
    routeMeta,
    ...(httpserver ? { httpserver } : {}),
    ...(httpserver ? { modules } : {}),
    _metadata: {
      version: '0.1.0',
      builtAt: Date.now(),
      keyDimension: options.keyDimension || 'perKey'
    }
  };
}
