import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { VirtualRouterError, VirtualRouterErrorCode } from "./virtual-router-contracts.js";
import { hasCompleteNativeBinding } from "./native-router-hotpath-policy.js";
import { REQUIRED_NATIVE_HOTPATH_EXPORTS } from "./native-router-hotpath-required-exports.js";

export type NativeRouterHotpathBinding = {
  [name: string]: unknown;
};

export const VIRTUAL_ROUTER_ERROR_PREFIX = "VIRTUAL_ROUTER_ERROR:";

type ParsedVirtualRouterNativeError = {
  code: VirtualRouterErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

function resolveLoaderModulePath(): string {
  if (typeof __filename === "string" && __filename.length > 0) {
    return __filename;
  }

  const stack = String(new Error().stack || "");
  for (const line of stack.split("\n")) {
    const match = line.match(
      /(file:\/\/[^\s)]+native-router-hotpath-loader\.(?:ts|js)|\/[^\s)]+native-router-hotpath-loader\.(?:ts|js))/,
    );
    if (!match) {
      continue;
    }
    const rawPath = match[1];
    if (rawPath.startsWith("file://")) {
      try {
        return decodeURIComponent(new URL(rawPath).pathname);
      } catch {
        continue;
      }
    }
    return rawPath;
  }

  return path.join(process.cwd(), "src/native/router-hotpath/native-router-hotpath-loader.ts");
}

const loaderModulePath = resolveLoaderModulePath();
const nodeRequire = createRequire(loaderModulePath);
const workspaceRoot = resolvePackageRoot(path.dirname(loaderModulePath));

let cachedBinding: NativeRouterHotpathBinding | null | undefined;
let cachedBindingCacheKey: string | undefined;

const REQUIRED_NATIVE_EXPORTS = REQUIRED_NATIVE_HOTPATH_EXPORTS;

function resolvePackageRoot(startDir: string): string {
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
  return path.resolve(startDir, "../../../");
}

function readNativePathFromEnv(): string | undefined {
  const raw = String(
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH ||
      process.env.RCC_LLMS_ROUTER_NATIVE_PATH ||
      "",
  ).trim();
  return raw || undefined;
}

function buildNativeBindingCacheKey(envPath: string | undefined): string {
  if (!envPath) {
    return "auto";
  }
  const resolved = path.isAbsolute(envPath)
    ? envPath
    : path.resolve(process.cwd(), envPath);
  return `env:${resolved}`;
}

function resolveLoadPathForNode(resolvedPath: string): string {
  const ext = path.extname(resolvedPath).toLowerCase();
  if (!ext || ext === ".node") {
    return resolvedPath;
  }
  if (ext !== ".dylib" && ext !== ".so" && ext !== ".dll") {
    return resolvedPath;
  }
  return resolvedPath.replace(/\.(dylib|so|dll)$/i, ".node");
}

function tryRequireFromPath(
  modulePath: string,
  options?: { requireComplete?: boolean },
): NativeRouterHotpathBinding | null {
  try {
    const resolved = path.isAbsolute(modulePath)
      ? modulePath
      : path.resolve(process.cwd(), modulePath);
    const loadPath = resolveLoadPathForNode(resolved);
    const loaded = nodeRequire(loadPath) as NativeRouterHotpathBinding;
    if (!loaded || typeof loaded !== "object") {
      return null;
    }
    if (
      options?.requireComplete !== false &&
      !hasCompleteNativeBinding(loaded, REQUIRED_NATIVE_EXPORTS)
    ) {
      return null;
    }
    return loaded;
  } catch {
    return null;
  }
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
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

function getModuleRelativeNativeCandidates(): string[] {
  const loaderDir = path.dirname(loaderModulePath);
  return dedupePaths([
    path.resolve(loaderDir, "../../../rust-core/target/release/router_hotpath_napi.node"),
    path.resolve(loaderDir, "../../../rust-core/target/debug/router_hotpath_napi.node"),
    path.resolve(loaderDir, "../router_hotpath_napi.node"),
  ]);
}

function getWorkspaceNativeCandidates(): string[] {
  return dedupePaths(["release", "debug"].map((mode) =>
    path.join(
      workspaceRoot,
      "rust-core",
      "target",
      mode,
      "router_hotpath_napi.node",
    ),
  ));
}

function getPackagedNativeCandidates(): string[] {
  return dedupePaths([
    path.join(workspaceRoot, "dist", "native", "router_hotpath_napi.node"),
  ]);
}

export function loadNativeRouterHotpathBinding(): NativeRouterHotpathBinding | null {
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
    if (cachedBinding) return cachedBinding;
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

export function resolveNativeModuleUrlFromEnv(): string | undefined {
  const modulePath = readNativePathFromEnv();
  if (!modulePath) {
    return undefined;
  }
  const normalized = path.isAbsolute(modulePath)
    ? modulePath
    : path.resolve(process.cwd(), modulePath);
  return pathToFileURL(normalized).href;
}

export function extractVirtualRouterNativeErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error ?? "unknown error");
}

export function parseVirtualRouterNativeErrorPayload(
  message: string,
): ParsedVirtualRouterNativeError | null {
  if (!message) {
    return null;
  }
  const normalized = message.startsWith("Error:") ? message.replace(/^Error:\s*/, "") : message;
  if (!normalized.startsWith(VIRTUAL_ROUTER_ERROR_PREFIX)) {
    return null;
  }
  const remainder = normalized.slice(VIRTUAL_ROUTER_ERROR_PREFIX.length);
  const index = remainder.indexOf(":");
  if (index <= 0) {
    return null;
  }
  const code = remainder.slice(0, index);
  if (!Object.values(VirtualRouterErrorCode).includes(code as VirtualRouterErrorCode)) {
    return null;
  }
  const rawPayload = remainder.slice(index + 1).trim();
  const fallbackMessage = rawPayload || "Virtual router error";
  if (!rawPayload.startsWith("{")) {
    return {
      code: code as VirtualRouterErrorCode,
      message: fallbackMessage,
    };
  }
  try {
    const parsed = JSON.parse(rawPayload) as {
      message?: unknown;
      details?: unknown;
    };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        code: code as VirtualRouterErrorCode,
        message: fallbackMessage,
      };
    }
    const parsedMessage =
      typeof parsed.message === "string" && parsed.message.trim()
        ? parsed.message.trim()
        : fallbackMessage;
    const details =
      parsed.details && typeof parsed.details === "object" && !Array.isArray(parsed.details)
        ? (parsed.details as Record<string, unknown>)
        : undefined;
    return {
      code: code as VirtualRouterErrorCode,
      message: parsedMessage,
      ...(details ? { details } : {}),
    };
  } catch {
    return {
      code: code as VirtualRouterErrorCode,
      message: fallbackMessage,
    };
  }
}

export function parseVirtualRouterNativeError(error: unknown): VirtualRouterError | null {
  const parsed = parseVirtualRouterNativeErrorPayload(
    extractVirtualRouterNativeErrorMessage(error),
  );
  if (!parsed) {
    return null;
  }
  return new VirtualRouterError(parsed.message, parsed.code, parsed.details);
}
