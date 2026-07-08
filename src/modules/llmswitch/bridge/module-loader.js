/**
 * Module Loader
 *
 * Core module loading utilities for the single llmswitch-core dist surface.
 */
import { createRequire } from 'module';
import path from 'path';
import { resolveCoreModulePath, resolveCoreModuleUrl } from '../core-loader.js';
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
function isJestRuntime() {
    return typeof process.env.JEST_WORKER_ID === 'string' && process.env.JEST_WORKER_ID.length > 0;
}
async function importCoreDist(subpath) {
    try {
        return await import(resolveCoreModuleUrl(subpath, 'ts'));
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`[llmswitch-bridge] Unable to load core module "${subpath}" (ts). 请确认 sharedmodule/llmswitch-core 依赖已安装（npm install）。${detail ? ` (${detail})` : ''}`);
    }
}
function requireCoreDist(subpath) {
    const modulePath = resolveCoreModulePath(subpath, 'ts');
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return nodeRequire(modulePath);
    }
    catch (error) {
        if (!isJestRuntime()) {
            throw error;
        }
        // Jest must still consume the built dist module. Re-throw with the original
        // module resolution failure instead of falling back to source TS.
        throw error;
    }
}
export { resolveCoreModulePath, importCoreDist, requireCoreDist };
