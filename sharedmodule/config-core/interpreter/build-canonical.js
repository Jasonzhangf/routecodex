function aliasBaseUrl(obj) {
    if (!obj)
        return;
    if (obj.baseURL && !obj.baseUrl)
        obj.baseUrl = obj.baseURL;
}
export function buildCanonical(system, user, options = {}) {
    if (!system.ok) {
        throw new Error(`System config invalid: ${(system.errors || []).join('; ')}`);
    }
    if (!user.ok) {
        throw new Error(`User config invalid: ${(user.errors || []).join('; ')}`);
    }
    const u = user.data || {};
    const vr = (u.virtualrouter || {});
    const providersIn = (vr.providers || {});
    const providers = {};
    for (const [pid, p] of Object.entries(providersIn)) {
        const cp = JSON.parse(JSON.stringify(p));
        aliasBaseUrl(cp);
        providers[pid] = cp;
    }
    // Build keyVault from user auth + keyMappings
    const keyVault = {};
    for (const [pid, prov] of Object.entries(providers)) {
        const auth = prov.auth;
        if (auth && typeof auth === 'object') {
            keyVault[pid] = keyVault[pid] || {};
            if (String(auth.type || '').toLowerCase() === 'apikey') {
                keyVault[pid]['key1'] = { type: 'apikey', value: String(auth.apiKey || ''), enabled: true };
            }
            else if (String(auth.type || '').toLowerCase() === 'oauth') {
                keyVault[pid]['key1'] = {
                    type: 'oauth',
                    oauth: {
                        grant: auth.grant,
                        clientId: auth.clientId,
                        clientSecret: auth.clientSecret,
                        tokenUrl: auth.tokenUrl,
                        scopes: Array.isArray(auth.scopes) ? auth.scopes : undefined
                    },
                    enabled: true
                };
            }
        }
    }
    // keyMappings.global → inject into keyVault (global scope, not provider-specific)
    try {
        const km = (vr.keyMappings || {});
        const globalMap = km.global && typeof km.global === 'object' ? km.global : {};
        if (Object.keys(globalMap).length) {
            // Put under a pseudo provider "global" unless provider-specific is desired.
            const pid = 'global';
            keyVault[pid] = keyVault[pid] || {};
            for (const [keyId, value] of Object.entries(globalMap)) {
                keyVault[pid][keyId] = { type: 'apikey', value: String(value), enabled: true };
            }
        }
        const provMap = km.providers && typeof km.providers === 'object' ? km.providers : {};
        for (const [pid, mp] of Object.entries(provMap)) {
            keyVault[pid] = keyVault[pid] || {};
            for (const [keyId, value] of Object.entries(mp || {})) {
                keyVault[pid][keyId] = { type: 'apikey', value: String(value), enabled: true };
            }
        }
    }
    catch { /* ignore keyMappings errors */ }
    // Pipelines: prefer explicit user.pipelines; otherwise empty for now (no inference)
    const pipelines = Array.isArray(u.pipelines) ? [...u.pipelines] : [];
    // Routing: copy categories, default to []
    const routing = Object.create(null);
    const cats = ['default', 'coding', 'longcontext', 'tools', 'thinking', 'vision', 'websearch', 'background'];
    const ur = (vr.routing || {});
    for (const c of cats) {
        const arr = Array.isArray(ur[c]) ? ur[c] : [];
        routing[c] = arr.map(String);
    }
    // routeMeta: derive from pipelines ids; pattern <providerId>.<modelId>[__<keyId>]
    const routeMeta = {};
    const parseId = (id) => {
        if (!id)
            return null;
        const parts = String(id).split('__');
        const base = parts[0];
        const keyId = parts.length > 1 ? parts.slice(1).join('__') : null;
        const dot = base.indexOf('.');
        if (dot <= 0 || dot >= base.length - 1)
            return null;
        const providerId = base.slice(0, dot);
        const modelId = base.slice(dot + 1);
        return { providerId, modelId, keyId };
    };
    const pushMeta = (id) => {
        const p = parseId(id);
        if (!p)
            return;
        routeMeta[id] = { providerId: p.providerId, modelId: p.modelId, keyId: p.keyId || null };
    };
    // PerKey expansion for pipelines when keyDimension=perKey and id has no __keyId
    const keyMode = (options.keyDimension || 'perKey');
    const expanded = [];
    const seenIds = new Set();
    const addPl = (pl) => { if (!seenIds.has(pl.id)) {
        expanded.push(pl);
        seenIds.add(pl.id);
        pushMeta(pl.id);
    } };
    for (const pl of pipelines) {
        const id = String(pl.id || '');
        const parsed = parseId(id);
        if (!parsed) {
            addPl(pl);
            continue;
        }
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
        }
        else {
            if (keyMode === 'perKey' && keyId) {
                // ensure authRef present
                if (!pl.authRef)
                    pl.authRef = { mode: 'perKey', providerId, keyId };
            }
            addPl(pl);
        }
    }
    // Routing expansion for perKey mode: <pid>.<mid> → all keys
    if (keyMode === 'perKey') {
        for (const [cat, arr] of Object.entries(routing)) {
            const out = [];
            for (const rid of arr) {
                const parsed = parseId(rid);
                if (!parsed) {
                    out.push(rid);
                    continue;
                }
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
                }
                else {
                    out.push(rid);
                }
            }
            // de-dup and stable sort
            routing[cat] = Array.from(new Set(out)).sort();
        }
    }
    // Project optional httpserver (no guessing)
    const httpUser = u.httpserver || {};
    const httpserver = ((typeof httpUser.port === 'number' && httpUser.port > 0) || (typeof httpUser.host === 'string' && httpUser.host.trim())) ? { port: httpUser.port, host: httpUser.host } : undefined;
    const modules = {};
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
//# sourceMappingURL=build-canonical.js.map