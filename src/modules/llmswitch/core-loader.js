import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const BUILTIN_SHARED_MODULE_REL = path.join('sharedmodule', 'llmswitch-core');
const PACKAGE_CANDIDATES = [
    BUILTIN_SHARED_MODULE_REL,
    path.join('node_modules', 'rcc-llmswitch-core'),
];
let corePackageDir = null;
function getImportMetaUrlUnsafe() {
    try {
        return Function('return import.meta.url')();
    }
    catch {
        return undefined;
    }
}
function resolveCoreLoaderModulePath() {
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
        const match = line.match(/(file:\/\/[^\s)]+core-loader\.(?:ts|js)|\/[^\s)]+core-loader\.(?:ts|js))/);
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
    return path.join(process.cwd(), 'src/modules/llmswitch/core-loader.ts');
}
function findPackageRootFromEntry(entryPath) {
    let current = path.dirname(entryPath);
    while (true) {
        const pkgJson = path.join(current, 'package.json');
        if (fs.existsSync(pkgJson)) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return null;
        }
        current = parent;
    }
}
function tryResolvePackageRootViaRequire(packageName, baseUrl) {
    try {
        const require = createRequire(baseUrl);
        const entry = require.resolve(packageName);
        return findPackageRootFromEntry(entry);
    }
    catch {
        return null;
    }
}
export function resolveCorePackageDir() {
    if (corePackageDir) {
        return corePackageDir;
    }
    const moduleDir = path.dirname(resolveCoreLoaderModulePath());
    const builtinCandidates = [
        path.resolve(moduleDir, '..', '..', '..', BUILTIN_SHARED_MODULE_REL),
        path.resolve(process.cwd(), BUILTIN_SHARED_MODULE_REL),
    ];
    for (const builtinDir of builtinCandidates) {
        const distDir = path.join(builtinDir, 'dist');
        if (fs.existsSync(distDir) && fs.existsSync(path.join(distDir, 'index.js'))) {
            corePackageDir = builtinDir;
            return builtinDir;
        }
    }
    const baseUrls = [
        pathToFileURL(path.join(path.dirname(resolveCoreLoaderModulePath()), 'package.json')).href,
        pathToFileURL(path.join(process.cwd(), 'package.json')).href,
    ];
    for (const baseUrl of baseUrls) {
        const root = tryResolvePackageRootViaRequire('rcc-llmswitch-core', baseUrl);
        if (root) {
            corePackageDir = root;
            return root;
        }
    }
    const startDirs = [
        path.dirname(resolveCoreLoaderModulePath()),
        process.cwd(),
    ];
    for (const startDir of startDirs) {
        let currentDir = startDir;
        while (true) {
            for (const pkgPath of PACKAGE_CANDIDATES) {
                const candidate = path.join(currentDir, pkgPath);
                if (fs.existsSync(candidate)) {
                    corePackageDir = candidate;
                    return candidate;
                }
            }
            const parent = path.dirname(currentDir);
            if (parent === currentDir) {
                break;
            }
            currentDir = parent;
        }
    }
    const targets = PACKAGE_CANDIDATES.map((pkg) => path.join('<project>', pkg)).join(' 或 ');
    throw new Error(`[llmswitch-core-loader] 无法定位 llmswitch 核心库，请执行 npm install 以确保 ${targets} 存在。`);
}
function resolveCoreDistPath(subpath) {
    const clean = subpath.replace(/^\/*/, '').replace(/\.js$/i, '');
    const distDir = path.join(resolveCorePackageDir(), 'dist');
    const candidate = path.join(distDir, `${clean}.js`);
    if (!fs.existsSync(candidate)) {
        throw new Error(`[llmswitch-core-loader] 未找到 ${candidate}，请确认对应核心库包含该模块。`);
    }
    return candidate;
}
export function resolveCoreModulePath(subpath) {
    return resolveCoreDistPath(subpath);
}
export function resolveCoreModuleUrl(subpath) {
    const modulePath = resolveCoreDistPath(subpath);
    return pathToFileURL(modulePath).href;
}
export async function importCoreModule(subpath) {
    return (await import(resolveCoreModuleUrl(subpath)));
}
