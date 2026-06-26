/**
 * Routing Integrations Bridge
 *
 * Virtual router bootstrap + hub pipeline constructor + host base dir resolver.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { importCoreDist, resolveImplForSubpath } from './module-loader.js';
function getImportMetaUrlUnsafe() {
    try {
        return Function('return import.meta.url')();
    }
    catch {
        return undefined;
    }
}
export async function bootstrapVirtualRouterConfig(input) {
    const mod = await importCoreDist('native/router-hotpath/native-virtual-router-bootstrap-config');
    const fn = mod.bootstrapVirtualRouterConfig;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] bootstrapVirtualRouterConfig not available');
    }
    return fn(input);
}
const cachedHubPipelineCtorByImpl = {
    ts: null,
    engine: null
};
export async function getHubPipelineCtor() {
    const impl = resolveImplForSubpath('conversion/hub/pipeline/hub-pipeline');
    if (!cachedHubPipelineCtorByImpl[impl]) {
        const mod = await importCoreDist('conversion/hub/pipeline/hub-pipeline', impl);
        const Ctor = mod.HubPipeline;
        if (typeof Ctor !== 'function') {
            throw new Error('[llmswitch-bridge] HubPipeline constructor not available');
        }
        cachedHubPipelineCtorByImpl[impl] = Ctor;
    }
    return cachedHubPipelineCtorByImpl[impl];
}
export async function getHubPipelineCtorForImpl(impl) {
    if (!cachedHubPipelineCtorByImpl[impl]) {
        const mod = await importCoreDist('conversion/hub/pipeline/hub-pipeline', impl);
        const Ctor = mod.HubPipeline;
        if (typeof Ctor !== 'function') {
            throw new Error('[llmswitch-bridge] HubPipeline constructor not available');
        }
        cachedHubPipelineCtorByImpl[impl] = Ctor;
    }
    return cachedHubPipelineCtorByImpl[impl];
}
export function resolveBaseDir() {
    const env = String(process.env.ROUTECODEX_BASEDIR || process.env.RCC_BASEDIR || '').trim();
    if (env)
        return env;
    const metaUrl = getImportMetaUrlUnsafe();
    if (typeof metaUrl === 'string' && metaUrl.length > 0) {
        try {
            const __filename = fileURLToPath(metaUrl);
            return path.resolve(path.dirname(__filename), '../../../..');
        }
        catch {
            // fall through
        }
    }
    return process.cwd();
}
