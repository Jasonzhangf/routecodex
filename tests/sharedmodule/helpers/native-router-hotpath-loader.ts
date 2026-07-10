import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

export type NativeRouterHotpathBinding = {
  [name: string]: unknown;
};

export enum VirtualRouterErrorCode {
  NO_STANDARDIZED_REQUEST = "NO_STANDARDIZED_REQUEST",
  ROUTE_NOT_FOUND = "ROUTE_NOT_FOUND",
  PROVIDER_NOT_AVAILABLE = "PROVIDER_NOT_AVAILABLE",
  HTTP_429 = "HTTP_429",
  CONFIG_ERROR = "CONFIG_ERROR",
}

export class VirtualRouterError extends Error {
  constructor(
    message: string,
    public readonly code: VirtualRouterErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "VirtualRouterError";
  }
}

export function isNativeDisabledByEnv(): boolean {
  return false;
}

export function hasCompleteNativeBinding(binding: unknown, requiredExports: readonly string[]): boolean {
  if (!binding || typeof binding !== "object") return false;
  const row = binding as Record<string, unknown>;
  return requiredExports.every((key) => typeof row[key] === "function");
}

export function makeNativeRequiredError(capability: string, reason?: string): Error {
  return new Error(
    `[virtual-router-native-hotpath] native ${capability} is required but unavailable${reason ? `: ${reason}` : ""}`
  );
}

export function failNativeRequired<T>(capability: string, reason?: string): T {
  throw makeNativeRequiredError(capability, reason);
}

export function failNative<T>(capability: string, reason?: string): T {
  return failNativeRequired<T>(capability, reason);
}

export const VIRTUAL_ROUTER_ERROR_PREFIX = "VIRTUAL_ROUTER_ERROR:";

const requiredExportsPath = path.resolve(
  process.cwd(),
  'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
);

function readRequiredNativeHotpathExports(): readonly string[] {
  const parsed = JSON.parse(fs.readFileSync(requiredExportsPath, 'utf8')) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string' && entry.trim())) {
    throw new Error('native-hotpath-required-exports.json must be a string array');
  }
  return [...new Set(parsed)];
}

export const REQUIRED_NATIVE_HOTPATH_EXPORTS = readRequiredNativeHotpathExports();

const NON_BLOCKING_PARSE_LOG_THROTTLE_MS = 60_000;
const nonBlockingParseLogState = new Map<string, number>();

type ParsedVirtualRouterNativeError = {
  code: VirtualRouterErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

function resolveLoaderModulePath(): string {
  if (
    typeof __filename === "string"
    && __filename.length > 0
    && __filename !== "[eval]"
    && path.isAbsolute(__filename)
  ) {
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

  return path.join(process.cwd(), "tests/sharedmodule/helpers/native-router-hotpath-loader.js");
}

const loaderModulePath = resolveLoaderModulePath();
const nodeRequire = createRequire(loaderModulePath);
const workspaceRoot = resolvePackageRoot(path.dirname(loaderModulePath));
const corePackageRoot = path.join(process.cwd(), "sharedmodule/llmswitch-core");

let cachedBinding: NativeRouterHotpathBinding | null | undefined;
let cachedBindingCacheKey: string | undefined;

const REQUIRED_NATIVE_EXPORTS = REQUIRED_NATIVE_HOTPATH_EXPORTS;

function toNapiExportName(name: string): string {
  return name.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
}

export function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBinding() as Record<string, unknown> | null;
  const fn = binding?.[name] ?? binding?.[toNapiExportName(name)];
  return typeof fn === "function" ? (fn as (...args: unknown[]) => unknown) : null;
}

export function loadNativeRouterHotpathBindingForInternalUse(): NativeRouterHotpathBinding | null {
  return loadNativeRouterHotpathBinding();
}

export function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  return safeStringify(error) ?? String(error);
}

export function extractNativeErrorMessage(raw: unknown): string {
  if (raw instanceof Error) {
    return raw.message;
  }
  if (raw && typeof raw === "object" && "message" in (raw as Record<string, unknown>)) {
    const candidate = (raw as Record<string, unknown>).message;
    return typeof candidate === "string" ? candidate : "";
  }
  return "";
}

export function stringifyNativePayloadForError(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length ? trimmed : undefined;
  }
  if (raw instanceof Error) {
    const message = typeof raw.message === "string" ? raw.message.trim() : "";
    if (message.length) {
      return message;
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const row = raw as Record<string, unknown>;
    const message = typeof row.message === "string" ? row.message.trim() : "";
    if (message.length) {
      return message;
    }
    const code = typeof row.code === "string" ? row.code.trim() : "";
    if (code.length) {
      return code;
    }
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

export function readNativeJsonResult(capability: string, raw: unknown): string {
  if (typeof raw === "string") {
    if (!raw) {
      return failNativeRequired<string>(capability, "empty result");
    }
    return raw;
  }
  const reason = stringifyNativePayloadForError(raw);
  if (reason) {
    throw new Error(reason);
  }
  return failNativeRequired<string>(capability, "empty result");
}

export function shouldRethrowNativeRawError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  return !error.message.startsWith("[virtual-router-native-hotpath] native ");
}

function logNativeJsonParserNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingParseLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_PARSE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingParseLogState.set(stage, now);
  const reason = stringifyNativePayloadForError(error) ?? "unknown";
  console.warn(`[native-router-hotpath-loader] ${stage} parse failed (non-blocking): ${reason}`);
}

export function parseNativeJsonValueOrFail<T>(capability: string, raw: string, stage = capability): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    logNativeJsonParserNonBlocking(stage, error);
    return failNativeRequired<T>(capability, "invalid payload");
  }
}

export function parseNativeJsonObjectOrFail<T extends Record<string, unknown>>(
  capability: string,
  raw: string,
  stage = capability,
): T {
  const parsed = parseNativeJsonValueOrFail<unknown>(capability, raw, stage);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failNativeRequired<T>(capability, "invalid payload");
  }
  return parsed as T;
}

export function parseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function parseRecord(raw: string): Record<string, unknown> | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

export function parseArray(raw: string): Array<unknown> | null {
  const parsed = parseJson(raw);
  return Array.isArray(parsed) ? parsed : null;
}

export function parseString(raw: string): string | null {
  const parsed = parseJson(raw);
  return typeof parsed === "string" ? parsed : null;
}

export function callNativeString(capability: string, input: Record<string, unknown>): string {
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw makeNativeRequiredError(capability);
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    throw makeNativeRequiredError(capability, "json stringify failed");
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== "string" || !raw) {
      throw new Error("empty result");
    }
    const parsed = parseString(raw);
    if (typeof parsed !== "string" || !parsed) {
      throw new Error("invalid payload");
    }
    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? "unknown");
    throw makeNativeRequiredError(capability, reason);
  }
}

export function resolveRccUserDirWithNative(homeDir?: string): string {
  return callNativeString("resolveRccUserDirJson", {
    homeDir,
    rccHome: process.env.RCC_HOME,
    routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
    routecodexHome: process.env.ROUTECODEX_HOME,
  });
}

export function resolveRccPathWithNative(...segments: string[]): string {
  return callNativeString("resolveRccPathJson", { segments });
}

export function parseStringArray(raw: string): string[] | null {
  const parsed = parseArray(raw);
  if (!parsed) {
    return null;
  }
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") {
      return null;
    }
    out.push(item);
  }
  return out;
}

function requireNativeFunction(capability: string, exportName: string): (...args: string[]) => unknown {
  if (isNativeDisabledByEnv()) {
    throw makeNativeRequiredError(capability, "native disabled");
  }
  const binding = loadNativeRouterHotpathBinding() as Record<string, unknown> | null;
  const fn = binding?.[exportName];
  if (typeof fn !== "function") {
    throw makeNativeRequiredError(capability);
  }
  return fn as (...args: string[]) => unknown;
}

export function callNativeJson<T>(
  capability: string,
  exportName: string,
  args: string[],
  parse: (raw: string) => T | null,
  options?: {
    createEmptyError?: () => Error;
    emptyReason?: string;
    invalidReason?: string;
    mapVirtualRouterErrors?: boolean;
    rethrowUnknownErrors?: boolean;
  },
): T {
  const fn = requireNativeFunction(capability, exportName);
  let raw: unknown;
  try {
    raw = fn(...args);
  } catch (error) {
    if (options?.mapVirtualRouterErrors) {
      const virtualRouterError = parseVirtualRouterNativeError(error);
      if (virtualRouterError) throw virtualRouterError;
    }
    if (options?.rethrowUnknownErrors) throw error;
    const reason = error instanceof Error ? error.message : String(error ?? "unknown");
    throw makeNativeRequiredError(capability, reason);
  }
  if (options?.mapVirtualRouterErrors) {
    const virtualRouterError = parseVirtualRouterNativeError(raw);
    if (virtualRouterError) throw virtualRouterError;
  }
  if (typeof raw !== "string" || !raw) {
    if (options?.createEmptyError) throw options.createEmptyError();
    throw makeNativeRequiredError(capability, options?.emptyReason ?? "empty result");
  }
  const parsed = parse(raw);
  if (!parsed) {
    throw makeNativeRequiredError(capability, options?.invalidReason ?? "invalid payload");
  }
  return parsed;
}

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
    path.resolve(loaderDir, "../router_hotpath_napi.node"),
    path.resolve(loaderDir, "../../../rust-core/target/release/router_hotpath_napi.node"),
    path.resolve(loaderDir, "../../../rust-core/target/debug/router_hotpath_napi.node"),
  ]);
}

function getWorkspaceNativeCandidates(): string[] {
  return dedupePaths(
    [workspaceRoot, corePackageRoot].flatMap((root) =>
      ["release", "debug"].map((mode) =>
        path.join(
          root,
          "rust-core",
          "target",
          mode,
          "router_hotpath_napi.node",
        ),
      ),
    ),
  );
}

function getPackagedNativeCandidates(): string[] {
  return dedupePaths([
    path.join(corePackageRoot, "dist", "native", "router_hotpath_napi.node"),
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
    ...getPackagedNativeCandidates(),
    ...getModuleRelativeNativeCandidates(),
    ...getWorkspaceNativeCandidates(),
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
