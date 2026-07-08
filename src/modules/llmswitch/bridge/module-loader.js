/**
 * Module Loader
 *
 * Core module loading utilities with ts/engine implementation selection.
 */
import { createRequire } from 'module';
import path from 'path';
import { resolveCorePackageDir, importCoreModule, resolveCoreModulePath } from '../core-loader.js';
function getImportMetaUrlUnsafe() {
    try {
        return Function('return import.meta.url')();
    }
    catch {
        return undefined;
    }
}
function resolveModuleLoaderPath() {
    const metaUrl = getImportMetaUrlUnsafe();
    if (typeof metaUrl === 'string' && metaUrl.length > 0) {
        try {
            return new URL(metaUrl).pathname;
        }
        catch {
            // continue to stack / cwd fallback
        }
    }
    if (typeof __filename === 'string' && __filename.length > 0) {
        return __filename;
    }
    const stack = String(new Error().stack || '');
    for (const line of stack.split('\n')) {
        const match = line.match(/(file:\/\/[^\s)]+module-loader\.(?:ts|js)|\/[^\s)]+module-loader\.(?:ts|js))/);
        if (!match) {
            continue;
        }
        const rawPath = match[1];
        if (rawPath.startsWith('file://')) {
            try {
                return decodeURIComponent(new URL(rawPath).pathname);
            }
            catch {
                continue;
            }
        }
        return rawPath;
    }
    return path.join(process.cwd(), 'src/modules/llmswitch/bridge/module-loader.ts');
}
function createNodeRequire() {
    const metaUrl = getImportMetaUrlUnsafe();
    if (typeof metaUrl === 'string' && metaUrl.length > 0) {
        try {
            return createRequire(metaUrl);
        }
        catch {
            // continue to path fallback
        }
    }
    return createRequire(resolveModuleLoaderPath());
}
const nodeRequire = createNodeRequire();
function getJestRequire() {
    if (!isJestRuntime()) {
        return null;
    }
    try {
        const jestRequire = Function('return typeof require === "function" ? require : null')();
        return typeof jestRequire === 'function' ? jestRequire : null;
    }
    catch {
        return null;
    }
}
function isJestRuntime() {
    return typeof process.env.JEST_WORKER_ID === 'string' && process.env.JEST_WORKER_ID.length > 0;
}
function resolveBuiltinSourceModulePath(subpath, impl) {
    if (impl !== 'ts') {
        return null;
    }
    try {
        const packageDir = resolveCorePackageDir(impl);
        const sourcePath = path.join(packageDir, 'src', `${subpath.replace(/^\/*/, '').replace(/\.js$/i, '')}.ts`);
        return sourcePath;
    }
    catch {
        return null;
    }
}
function shouldPreferSourceInJest(subpath, impl) {
    if (impl !== 'ts' || !isJestRuntime()) {
        return false;
    }
    const jestDistOnlyPrefixes = [
        'native/router-hotpath/native-failure-policy',
        'native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol',
        'native/router-hotpath/native-virtual-router-routing-state'
    ];
    if (matchesPrefix(subpath, jestDistOnlyPrefixes)) {
        return false;
    }
    return true;
}
function parsePrefixList(raw) {
    return String(raw || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.replace(/^\/*/, '').replace(/\/+$/, ''));
}
function matchesPrefix(subpath, prefixes) {
    if (!prefixes.length) {
        return false;
    }
    const normalized = subpath.replace(/^\/*/, '').replace(/\.js$/i, '');
    return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}
function isEngineEnabled() {
    const raw = String(process.env.ROUTECODEX_LLMS_ENGINE_ENABLE || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
}
function getEnginePrefixes() {
    return parsePrefixList(process.env.ROUTECODEX_LLMS_ENGINE_PREFIXES);
}
function resolveImplForSubpath(subpath) {
    if (!isEngineEnabled()) {
        return 'ts';
    }
    const enginePrefixes = getEnginePrefixes();
    if (matchesPrefix(subpath, enginePrefixes)) {
        return 'engine';
    }
    return 'ts';
}
async function importCoreDist(subpath, impl = resolveImplForSubpath(subpath)) {
    try {
        return await importCoreModule(subpath, impl);
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const pkg = impl === 'engine' ? 'rcc-llmswitch-engine' : 'sharedmodule/llmswitch-core';
        throw new Error(`[llmswitch-bridge] Unable to load core module "${subpath}" (${impl}). 请确认 ${pkg} 依赖已安装（npm install）。${detail ? ` (${detail})` : ''}`);
    }
}
function requireCoreDist(subpath, impl = resolveImplForSubpath(subpath)) {
    if (impl === 'engine' && !isEngineEnabled()) {
        throw new Error('[llmswitch-bridge] ROUTECODEX_LLMS_ENGINE_ENABLE must be enabled to load engine core');
    }
    if (shouldPreferSourceInJest(subpath, impl)) {
        const sourcePath = resolveBuiltinSourceModulePath(subpath, impl);
        if (sourcePath) {
            const jestRequire = getJestRequire();
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            return (jestRequire ?? nodeRequire)(sourcePath);
        }
    }
    const modulePath = resolveCoreModulePath(subpath, impl);
    try {
        const jestRequire = getJestRequire();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return (jestRequire ?? nodeRequire)(modulePath);
    }
    catch (error) {
        if (isJestRuntime()) {
            const sourcePath = resolveBuiltinSourceModulePath(subpath, impl);
            if (sourcePath) {
                try {
                    const jestRequire = getJestRequire();
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    return (jestRequire ?? nodeRequire)(sourcePath);
                }
                catch {
                    // fall through to original error below
                }
            }
        }
        throw error;
    }
}
export { parsePrefixList, matchesPrefix, isEngineEnabled, getEnginePrefixes, resolveImplForSubpath, resolveCoreModulePath, importCoreDist, requireCoreDist };
