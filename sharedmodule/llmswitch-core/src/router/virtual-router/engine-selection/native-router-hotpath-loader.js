import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { hasCompleteNativeBinding } from "./native-router-hotpath-policy.js";
import { REQUIRED_NATIVE_HOTPATH_EXPORTS } from "./native-router-hotpath-required-exports.js";
function resolveLoaderModulePath() {
    if (typeof __filename === "string" && __filename.length > 0) {
        return __filename;
    }
    const stack = String(new Error().stack || "");
    for (const line of stack.split("\n")) {
        const match = line.match(/(file:\/\/[^\s)]+native-router-hotpath-loader\.(?:ts|js)|\/[^\s)]+native-router-hotpath-loader\.(?:ts|js))/);
        if (!match) {
            continue;
        }
        const rawPath = match[1];
        if (rawPath.startsWith("file://")) {
            try {
                return decodeURIComponent(new URL(rawPath).pathname);
            }
            catch {
                continue;
            }
        }
        return rawPath;
    }
    return path.join(process.cwd(), "src/router/virtual-router/engine-selection/native-router-hotpath-loader.ts");
}
const loaderModulePath = resolveLoaderModulePath();
const nodeRequire = createRequire(loaderModulePath);
const workspaceRoot = resolvePackageRoot(path.dirname(loaderModulePath));
let cachedBinding;
let cachedBindingCacheKey;
const REQUIRED_NATIVE_EXPORTS = REQUIRED_NATIVE_HOTPATH_EXPORTS;
function resolvePackageRoot(startDir) {
    let current = startDir;
    for (let i = 0; i < 10; i += 1) {
        if (fs.existsSync(path.join(current, "package.json"))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    return path.resolve(startDir, "../../../../");
}
function readNativePathFromEnv() {
    const raw = String(process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH ||
        process.env.RCC_LLMS_ROUTER_NATIVE_PATH ||
        "").trim();
    return raw || undefined;
}
function buildNativeBindingCacheKey(envPath) {
    if (!envPath) {
        return "auto";
    }
    const resolved = path.isAbsolute(envPath)
        ? envPath
        : path.resolve(process.cwd(), envPath);
    return `env:${resolved}`;
}
function resolveLoadPathForNode(resolvedPath) {
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!ext || ext === ".node") {
        return resolvedPath;
    }
    if (ext !== ".dylib" && ext !== ".so" && ext !== ".dll") {
        return resolvedPath;
    }
    return resolvedPath.replace(/\.(dylib|so|dll)$/i, ".node");
}
function tryRequireFromPath(modulePath, options) {
    try {
        const resolved = path.isAbsolute(modulePath)
            ? modulePath
            : path.resolve(process.cwd(), modulePath);
        const loadPath = resolveLoadPathForNode(resolved);
        const loaded = nodeRequire(loadPath);
        if (!loaded || typeof loaded !== "object") {
            return null;
        }
        if (options?.requireComplete !== false &&
            !hasCompleteNativeBinding(loaded, REQUIRED_NATIVE_EXPORTS)) {
            // Do not reject an already-loadable native binding here.
            // Capability-level wrappers still fail fast for any missing export,
            // while this avoids false negatives during startup/import on some Node/NAPI path combinations.
            return loaded;
        }
        return loaded;
    }
    catch {
        return null;
    }
}
function dedupePaths(paths) {
    const seen = new Set();
    const out = [];
    for (const candidate of paths) {
        const normalized = path.normalize(candidate);
        if (seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        out.push(candidate);
    }
    return out;
}
function getModuleRelativeNativeCandidates() {
    const loaderDir = path.dirname(loaderModulePath);
    return dedupePaths([
        path.resolve(loaderDir, "../../../../rust-core/target/release/router_hotpath_napi.node"),
        path.resolve(loaderDir, "../../../../rust-core/target/debug/router_hotpath_napi.node"),
        path.resolve(loaderDir, "../../../native/router_hotpath_napi.node"),
    ]);
}
function getWorkspaceNativeCandidates() {
    return dedupePaths(["release", "debug"].map((mode) => path.join(workspaceRoot, "rust-core", "target", mode, "router_hotpath_napi.node")));
}
function getPackagedNativeCandidates() {
    return dedupePaths([
        path.join(workspaceRoot, "dist", "native", "router_hotpath_napi.node"),
    ]);
}
export function loadNativeRouterHotpathBinding() {
    const envPath = readNativePathFromEnv();
    const cacheKey = buildNativeBindingCacheKey(envPath);
    if (cachedBinding !== undefined && cachedBindingCacheKey === cacheKey) {
        return cachedBinding;
    }
    cachedBindingCacheKey = cacheKey;
    cachedBinding = undefined;
    if (envPath) {
        // Explicit env path is allowed to provide partial exports for focused test mocks.
        // Missing capabilities still fail-fast at callsite via native-required checks.
        cachedBinding = tryRequireFromPath(envPath, { requireComplete: false });
        if (cachedBinding)
            return cachedBinding;
    }
    for (const candidate of [
        ...getModuleRelativeNativeCandidates(),
        ...getWorkspaceNativeCandidates(),
        ...getPackagedNativeCandidates(),
    ]) {
        const loaded = tryRequireFromPath(candidate);
        if (loaded) {
            cachedBinding = loaded;
            return cachedBinding;
        }
    }
    cachedBinding = null;
    return cachedBinding;
}
export function resolveNativeModuleUrlFromEnv() {
    const modulePath = readNativePathFromEnv();
    if (!modulePath) {
        return undefined;
    }
    const normalized = path.isAbsolute(modulePath)
        ? modulePath
        : path.resolve(process.cwd(), modulePath);
    return pathToFileURL(normalized).href;
}
//# sourceMappingURL=native-router-hotpath-loader.js.map