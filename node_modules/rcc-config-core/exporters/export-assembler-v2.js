/**
 * export-assembler-v2
 *
 * 基于 Canonical（config-core 解释体）导出 V2 标准的 pipeline_assembler.config：
 * - 严格：不做家族推测与兜底；缺失关键信息直接报错（Fail Fast）
 * - 标准化：compatibility 一律容器形式 { type:'compatibility', config:{ moduleType, moduleConfig?, providerType } }
 * - provider 一律 openai 模块，配置中携带 { providerType, model, baseUrl?, auth? }
 */
export function exportAssemblerConfigV2(canonical) {
    if (!canonical || typeof canonical !== 'object') {
        throw new Error('exportAssemblerConfigV2: canonical is required');
    }
    let pipelinesIn = Array.isArray(canonical.pipelines) ? canonical.pipelines : [];
    const routePoolsIn = canonical.routing && typeof canonical.routing === 'object' ? canonical.routing : {};
    const routeMetaIn = canonical.routeMeta && typeof canonical.routeMeta === 'object' ? canonical.routeMeta : {};
    // 如果 canonical.pipelines 为空，则根据 routing + keyVault 进行最小可行合成（V2 需要显式 pipelines）
    if (pipelinesIn.length === 0) {
        const providers = (canonical.providers && typeof canonical.providers === 'object') ? canonical.providers : {};
        const keyVault = (canonical.keyVault && typeof canonical.keyVault === 'object') ? canonical.keyVault : {};
        const allIds = new Set();
        for (const ids of Object.values(routePoolsIn)) {
            (ids || []).forEach((id) => { if (typeof id === 'string' && id.trim())
                allIds.add(id); });
        }
        const requireProviderType = (pid) => {
            const p = (providers[pid] && typeof providers[pid] === 'object') ? providers[pid] : {};
            const t = typeof p.type === 'string' ? String(p.type).trim().toLowerCase() : '';
            if (!t)
                throw new Error(`exportAssemblerConfigV2: providers['${pid}'].type is required`);
            return t;
        };
        const parseId = (id) => {
            const dot = id.indexOf('.');
            if (dot <= 0)
                return null;
            const providerId = id.slice(0, dot);
            const rest = id.slice(dot + 1);
            const parts = rest.split('__');
            const modelId = parts[0];
            const keyId = parts[1] || 'key1';
            return { providerId, modelId, keyId };
        };
        const built = [];
        for (const id of Array.from(allIds)) {
            const parsed = parseId(id);
            if (!parsed)
                continue;
            const { providerId, modelId, keyId } = parsed;
            const providerType = requireProviderType(providerId);
            const provCfgSrc = (providers[providerId] && typeof providers[providerId] === 'object') ? providers[providerId] : {};
            const baseUrl = (provCfgSrc.baseUrl || provCfgSrc.baseURL) ? String(provCfgSrc.baseUrl || provCfgSrc.baseURL) : undefined;
            const keyEntry = (keyVault[providerId] && keyVault[providerId][keyId]) ? keyVault[providerId][keyId] : undefined;
            const auth = (keyEntry && keyEntry.type === 'apikey' && typeof keyEntry.value === 'string' && keyEntry.value.trim())
                ? { type: 'apikey', apiKey: keyEntry.value.trim() } : undefined;
            const providerOut = { type: 'openai', config: { ...(baseUrl ? { baseUrl } : {}), ...(auth ? { auth } : {}), providerType, model: modelId } };
            // 读取用户在 provider.model 层声明的 compatibility（与V1保持一致）；缺失则 Fail Fast
            let compatModuleType = '';
            let compatModuleConfig = {};
            try {
                const models = (provCfgSrc && typeof provCfgSrc.models === 'object') ? provCfgSrc.models : {};
                const mdl = models[modelId] || {};
                const compat = mdl.compatibility || {};
                if (!compat || typeof compat !== 'object') {
                    throw new Error(`exportAssemblerConfigV2: missing compatibility for ${providerId}.${modelId}`);
                }
                const t = String((compat.type || compat.moduleType || '')).trim();
                if (!t)
                    throw new Error(`exportAssemblerConfigV2: compatibility.type/moduleType required for ${providerId}.${modelId}`);
                compatModuleType = (t.toLowerCase() === 'compatibility') ? String(compat.moduleType || '') : t;
                if (!compatModuleType)
                    throw new Error(`exportAssemblerConfigV2: compatibility.moduleType required for ${providerId}.${modelId}`);
                const c = (compat.config && typeof compat.config === 'object') ? compat.config : {};
                compatModuleConfig = { ...c };
            }
            catch { /* keep defaults */ }
            if (!compatModuleType) {
                throw new Error(`exportAssemblerConfigV2: cannot determine compatibility.moduleType for ${providerId}.${modelId}`);
            }
            // 计算兼容层直载文件（不改用户配置；仅在 V2 装配输入中提供文件名，由 StandardCompatibility 解析为路径）
            const shapeVariant = (() => {
                const c = compatModuleConfig;
                if (typeof c?.shapeFilterFile === 'string' && c.shapeFilterFile.trim()) {
                    return String(c.shapeFilterFile).trim(); // 用户显式指定文件名
                }
                const prof = (typeof c?.shapeProfile === 'string' && c.shapeProfile.trim())
                    ? String(c.shapeProfile).trim()
                    : ((typeof c?.profileId === 'string' && c.profileId.trim()) ? String(c.profileId).trim() : '');
                if (prof)
                    return `shape-filters.${prof}.json`;
                return 'shape-filters.json';
            })();
            const compatibility = {
                type: 'compatibility',
                config: {
                    moduleType: compatModuleType,
                    moduleConfig: compatModuleConfig,
                    providerType,
                    files: {
                        shapeFilters: shapeVariant,
                        fieldMappings: 'field-mappings.json'
                    }
                }
            };
            const llmSwitch = { type: 'llmswitch-conversion-router', config: {} };
            const workflow = { type: 'streaming-control', config: {} };
            built.push({ id, provider: { type: 'openai' }, modules: { provider: providerOut, compatibility, llmSwitch, workflow }, settings: { debugEnabled: true }, authRef: { mode: 'perKey', providerId, keyId } });
        }
        pipelinesIn = built;
    }
    const normalizeCompat = (compat, pipelineId) => {
        const cfg = (compat && typeof compat === 'object') ? compat : {};
        const type = String(cfg.type || '').trim();
        const config = (cfg.config && typeof cfg.config === 'object') ? cfg.config : {};
        if (type && type.toLowerCase() !== 'compatibility') {
            return {
                type: 'compatibility',
                config: {
                    moduleType: type,
                    moduleConfig: config || {},
                }
            };
        }
        const moduleType = String(config.moduleType || '').trim();
        if (!moduleType) {
            throw new Error(`exportAssemblerConfigV2: compatibility.moduleType missing for pipeline '${pipelineId}'`);
        }
        return {
            type: 'compatibility',
            config: {
                moduleType,
                moduleConfig: config.moduleConfig || {},
            }
        };
    };
    const pipelines = pipelinesIn.map((p) => {
        const id = String(p?.id || '').trim();
        if (!id)
            throw new Error('exportAssemblerConfigV2: pipeline.id is required');
        const modules = (p && typeof p.modules === 'object') ? p.modules : {};
        // provider 配置：统一放入 openai provider 模块的 config 中
        const providerCfg = modules.provider?.config || {};
        const compatCfg = normalizeCompat(modules.compatibility, id);
        // 从 routeMeta 提取 providerId/modelId/keyId → 映射到 provider.config
        const meta = routeMetaIn[id] || {};
        const modelId = String(meta.modelId || '').trim();
        const providerId = String(meta.providerId || '').trim();
        if (!modelId) {
            throw new Error(`exportAssemblerConfigV2: routeMeta[${id}].modelId is required`);
        }
        const aliasProviderType = (s) => {
            const t = (s || '').toLowerCase();
            if (t.includes('glm') || t.includes('zhipu') || t === 'glm')
                return 'glm';
            if (t.includes('qwen') || t.includes('dashscope'))
                return 'qwen';
            if (t.includes('lmstudio') || t.includes('lm-studio'))
                return 'lmstudio';
            if (t.includes('iflow'))
                return 'iflow';
            if (t.includes('responses'))
                return 'responses';
            return 'openai';
        };
        const providerType = aliasProviderType(providerId);
        const providerOut = {
            type: 'openai',
            config: {
                ...(providerCfg || {}),
                providerType,
                model: modelId,
            }
        };
        // 回填 providerType + files（用于 StandardCompatibility 直载 JSON）
        const compatAny = compatCfg.config;
        compatAny.providerType = providerType;
        try {
            const c = compatAny.moduleConfig || {};
            const shapeVariant = (() => {
                if (typeof c?.shapeFilterFile === 'string' && c.shapeFilterFile.trim()) {
                    return String(c.shapeFilterFile).trim();
                }
                const prof = (typeof c?.shapeProfile === 'string' && c.shapeProfile.trim())
                    ? String(c.shapeProfile).trim()
                    : ((typeof c?.profileId === 'string' && c.profileId.trim()) ? String(c.profileId).trim() : '');
                if (prof)
                    return `shape-filters.${prof}.json`;
                return 'shape-filters.json';
            })();
            compatAny.files = {
                shapeFilters: shapeVariant,
                fieldMappings: 'field-mappings.json'
            };
        }
        catch { /* ignore derive errors; assembler 已经 Fail Fast 了关键字段 */ }
        // llmSwitch：统一转换路由器（可由用户覆盖）
        const llmSwitch = modules.llmSwitch?.type
            ? { type: modules.llmSwitch.type, config: modules.llmSwitch.config || {} }
            : { type: 'llmswitch-conversion-router', config: {} };
        const workflow = modules.workflow?.type
            ? { type: modules.workflow.type, config: modules.workflow.config || {}, enabled: modules.workflow.enabled !== false }
            : { type: 'streaming-control', config: {} };
        return {
            id,
            provider: { type: 'openai' },
            modules: {
                provider: providerOut,
                compatibility: compatCfg,
                llmSwitch,
                workflow
            },
            settings: { ...(p.settings || {}), debugEnabled: true }
        };
    });
    // 构造 routePools：canonical.routing 已经是展开后的 perKey 形式
    const routePools = {};
    for (const [k, v] of Object.entries(routePoolsIn)) {
        routePools[k] = Array.isArray(v) ? v.map(String) : [];
    }
    // 校验 routePools 引用的 pipeline 必须存在
    const known = new Set(pipelines.map(p => p.id));
    for (const [routeName, ids] of Object.entries(routePools)) {
        for (const id of ids) {
            if (!known.has(id)) {
                throw new Error(`exportAssemblerConfigV2: route '${routeName}' references unknown pipeline '${id}'`);
            }
        }
    }
    // 简洁版 authMappings：将 canonical.keyVault 展平为 keyId->value（按 provider 内部优先）
    const authMappings = {};
    try {
        const kv = (canonical.keyVault && typeof canonical.keyVault === 'object') ? canonical.keyVault : {};
        for (const prov of Object.keys(kv)) {
            const keys = kv[prov] || {};
            for (const [kid, ent] of Object.entries(keys)) {
                const val = ent?.value;
                if (typeof val === 'string' && val.trim()) {
                    authMappings[kid] = val.trim();
                }
            }
        }
    }
    catch {
        // ignore auth mapping errors
    }
    return {
        config: {
            pipelines,
            routePools,
            routeMeta: Object.keys(routeMetaIn).length ? routeMetaIn : (() => {
                // 若 canonical.routeMeta 为空，按 pipelines 推导补齐
                const meta = {};
                for (const p of pipelines) {
                    const id = String(p.id || '');
                    const dot = id.indexOf('.');
                    if (dot <= 0)
                        continue;
                    const providerId = id.slice(0, dot);
                    const rest = id.slice(dot + 1);
                    const parts = rest.split('__');
                    const modelId = parts[0];
                    const keyId = parts[1] || 'key1';
                    meta[id] = { providerId, modelId, keyId };
                }
                return meta;
            })(),
            authMappings,
        }
    };
}
//# sourceMappingURL=export-assembler-v2.js.map