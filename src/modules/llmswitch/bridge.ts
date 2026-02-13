import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { importCoreModule, resolveCoreModulePath, type LlmsImpl } from './core-loader.js';
import { x7eGate } from '../../server/runtime/http-server/daemon-admin/routecodex-x7e-gate.js';
import type { ProviderErrorEvent, ProviderSuccessEvent } from '@jsonstudio/llms/dist/router/virtual-router/types.js';
import { writeErrorsampleJson } from '../../utils/errorsamples.js';
import {
  isLlmsEngineShadowEnabledForSubpath,
  recordLlmsEngineShadowDiff,
  resolveLlmsEngineShadowConfig,
  shouldRunLlmsEngineShadowForSubpath
} from '../../utils/llms-engine-shadow.js';
import { buildInfo } from '../../build-info.js';
import { resolveLlmswitchCoreVersion } from '../../utils/runtime-versions.js';

type AnyRecord = Record<string, unknown>;
type SnapshotRecorder = unknown;

// 单一桥接模块：这是全项目中唯一允许直接 import llmswitch-core 的地方。
// 其它代码（pipeline/provider/server/virtual-router/snapshot）都只能通过这里暴露的统一接口访问 llmswitch-core。
// 默认引用 @jsonstudio/llms（来自 npm 发布版本）。仓库开发场景可通过 scripts/link-llmswitch.mjs 将该依赖 link 到本地 sharedmodule。

export type { ProviderErrorEvent } from '@jsonstudio/llms/dist/router/virtual-router/types.js';
export type { ProviderSuccessEvent } from '@jsonstudio/llms/dist/router/virtual-router/types.js';
export type { ProviderUsageEvent } from '@jsonstudio/llms';
export type {
  StaticQuotaConfig,
  QuotaState,
  QuotaStore,
  QuotaStoreSnapshot
} from '@jsonstudio/llms/dist/quota/index.js';

const require = createRequire(import.meta.url);

function parsePrefixList(raw: string | undefined): string[] {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^\/*/, '').replace(/\/+$/, ''));
}

function matchesPrefix(subpath: string, prefixes: string[]): boolean {
  if (!prefixes.length) {
    return false;
  }
  const normalized = subpath.replace(/^\/*/, '').replace(/\.js$/i, '');
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function isEngineEnabled(): boolean {
  const raw = String(process.env.ROUTECODEX_LLMS_ENGINE_ENABLE || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function getEnginePrefixes(): string[] {
  return parsePrefixList(process.env.ROUTECODEX_LLMS_ENGINE_PREFIXES);
}

function resolveImplForSubpath(subpath: string): LlmsImpl {
  if (!isEngineEnabled()) {
    return 'ts';
  }
  const enginePrefixes = getEnginePrefixes();
  if (matchesPrefix(subpath, enginePrefixes)) {
    return 'engine';
  }
  return 'ts';
}

async function importCoreDist<TModule extends object = AnyRecord>(
  subpath: string,
  impl: LlmsImpl = resolveImplForSubpath(subpath)
): Promise<TModule> {
  try {
    return await importCoreModule<TModule>(subpath, impl);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const pkg = impl === 'engine' ? '@jsonstudio/llms-engine' : '@jsonstudio/llms';
    throw new Error(
      `[llmswitch-bridge] Unable to load core module "${subpath}" (${impl}). 请确认 ${pkg} 依赖已安装（npm install）。${detail ? ` (${detail})` : ''}`
    );
  }
}

function requireCoreDist<TModule extends object = AnyRecord>(
  subpath: string,
  impl: LlmsImpl = resolveImplForSubpath(subpath)
): TModule {
  if (impl === 'engine' && !isEngineEnabled()) {
    throw new Error('[llmswitch-bridge] ROUTECODEX_LLMS_ENGINE_ENABLE must be enabled to load engine core');
  }
  const modulePath = resolveCoreModulePath(subpath, impl);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modulePath) as TModule;
}

type AntigravitySessionSignatureModule = {
  extractAntigravityGeminiSessionId?: (payload: unknown) => string;
  cacheAntigravitySessionSignature?: (...args: unknown[]) => void;
  getAntigravityLatestSignatureSessionIdForAlias?: (aliasKey: string, options?: { hydrate?: boolean }) => string | undefined;
  lookupAntigravitySessionSignatureEntry?: (aliasKey: string, sessionId: string, options?: { hydrate?: boolean }) => unknown;
  invalidateAntigravitySessionSignature?: (aliasKey: string, sessionId: string) => void;
  resetAntigravitySessionSignatureCachesForTests?: () => void;
  configureAntigravitySessionSignaturePersistence?: (input: { stateDir: string; fileName?: string } | null) => void;
  flushAntigravitySessionSignaturePersistenceSync?: () => void;
};

type QuotaModule = {
  QuotaManager?: new (options?: { store?: unknown }) => {
    hydrateFromStore?: () => Promise<void>;
    registerProviderStaticConfig?: (providerKey: string, cfg: unknown) => void;
    onProviderError?: (ev: ProviderErrorEvent) => void;
    onProviderSuccess?: (ev: ProviderSuccessEvent) => void;
    updateProviderPoolState?: (options: unknown) => void;
    disableProvider?: (options: unknown) => void;
    recoverProvider?: (providerKey: string) => void;
    resetProvider?: (providerKey: string) => void;
    getQuotaView?: () => unknown;
    getSnapshot?: () => unknown;
    persistNow?: () => Promise<void>;
  };
};

let cachedAntigravitySignatureModule: AntigravitySessionSignatureModule | null = null;
let antigravitySignatureModuleWarmupPromise: Promise<AntigravitySessionSignatureModule | null> | null = null;

function loadAntigravitySignatureModule(): AntigravitySessionSignatureModule | null {
  if (cachedAntigravitySignatureModule) {
    return cachedAntigravitySignatureModule;
  }
  try {
    cachedAntigravitySignatureModule = requireCoreDist<AntigravitySessionSignatureModule>(
      'conversion/compat/antigravity-session-signature'
    );
  } catch {
    cachedAntigravitySignatureModule = null;
  }
  return cachedAntigravitySignatureModule;
}

export async function warmupAntigravitySessionSignatureModule(): Promise<void> {
  if (cachedAntigravitySignatureModule) {
    return;
  }
  if (!antigravitySignatureModuleWarmupPromise) {
    antigravitySignatureModuleWarmupPromise = (async () => {
      try {
        return await importCoreDist<AntigravitySessionSignatureModule>('conversion/compat/antigravity-session-signature');
      } catch {
        return null;
      }
    })();
  }
  try {
    cachedAntigravitySignatureModule = await antigravitySignatureModuleWarmupPromise;
  } finally {
    antigravitySignatureModuleWarmupPromise = null;
  }
}

export function extractAntigravityGeminiSessionId(payload: unknown): string | undefined {
  const mod = loadAntigravitySignatureModule();
  const fn = mod?.extractAntigravityGeminiSessionId;
  if (typeof fn !== 'function') {
    return undefined;
  }
  try {
    return fn(payload);
  } catch {
    return undefined;
  }
}

export function cacheAntigravitySessionSignature(aliasKey: string, sessionId: string, signature: string, messageCount?: number): void;
export function cacheAntigravitySessionSignature(sessionId: string, signature: string, messageCount?: number): void;
export function cacheAntigravitySessionSignature(a: string, b: string, c?: string | number, d = 1): void {
  const mod = loadAntigravitySignatureModule();
  const fn = mod?.cacheAntigravitySessionSignature;
  if (typeof fn !== 'function') {
    return;
  }
  const supportsAliasKey =
    typeof (mod as any)?.getAntigravitySessionSignature === 'function' &&
    ((mod as any).getAntigravitySessionSignature as (...args: unknown[]) => unknown).length >= 2;
  const isNewSignature = typeof c === 'string';
  const aliasKey = isNewSignature ? a : 'antigravity.unknown';
  const sessionId = isNewSignature ? b : a;
  const signature = isNewSignature ? (c as string) : b;
  const messageCount = typeof c === 'number' ? c : typeof d === 'number' ? d : 1;
  try {
    if (isNewSignature && supportsAliasKey) {
      fn(aliasKey, sessionId, signature, messageCount);
    } else {
      fn(sessionId, signature, messageCount);
    }
  } catch {
    // best-effort only
  }
}

export function getAntigravityLatestSignatureSessionIdForAlias(
  aliasKey: string,
  options?: { hydrate?: boolean }
): string | undefined {
  const mod = loadAntigravitySignatureModule();
  const fn = mod?.getAntigravityLatestSignatureSessionIdForAlias;
  if (typeof fn !== 'function') {
    return undefined;
  }
  try {
    const out = fn(aliasKey, options);
    return typeof out === 'string' && out.trim().length ? out.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function lookupAntigravitySessionSignatureEntry(
  aliasKey: string,
  sessionId: string,
  options?: { hydrate?: boolean }
): Record<string, unknown> | undefined {
  const mod = loadAntigravitySignatureModule();
  const fn = mod?.lookupAntigravitySessionSignatureEntry;
  if (typeof fn !== 'function') {
    return undefined;
  }
  try {
    const out = fn(aliasKey, sessionId, options);
    return out && typeof out === 'object' ? (out as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function invalidateAntigravitySessionSignature(aliasKey: string, sessionId: string): void {
  const mod = loadAntigravitySignatureModule();
  const fn = mod?.invalidateAntigravitySessionSignature;
  if (typeof fn !== 'function') {
    return;
  }
  try {
    fn(aliasKey, sessionId);
  } catch {
    // best-effort only
  }
}

export function resetAntigravitySessionSignatureCachesForTests(): void {
  const mod = loadAntigravitySignatureModule();
  const fn = mod?.resetAntigravitySessionSignatureCachesForTests;
  if (typeof fn !== 'function') {
    return;
  }
  try {
    fn();
  } catch {
    // best-effort only
  }
}

let quotaModulePromise: Promise<QuotaModule | null> | null = null;
let cachedQuotaModuleError: string | null = null;

async function importQuotaModule(): Promise<QuotaModule | null> {
  if (!quotaModulePromise) {
    quotaModulePromise = (async () => {
      try {
        const mod = await importCoreDist<QuotaModule>('quota/index');
        cachedQuotaModuleError = null;
        return mod;
      } catch {
        cachedQuotaModuleError = 'failed to import core module quota/index (resolveCoreModulePath or import failed)';
        return null;
      }
    })();
  }
  return await quotaModulePromise;
}

export async function createCoreQuotaManager(options?: { store?: unknown }): Promise<unknown> {
  // X7E Phase 0 Gate: fallback to null if unified quota path is disabled
  if (!x7eGate.phase1UnifiedQuota) {
    return null;
  }
  const mod = await importQuotaModule();
  const Ctor = mod?.QuotaManager;
  if (typeof Ctor !== 'function') {
    throw new Error(
      `[llmswitch-bridge] core QuotaManager not available; please update @jsonstudio/llms${cachedQuotaModuleError ? ` (${cachedQuotaModuleError})` : ''}`
    );
  }
  return new Ctor({ ...(options ?? {}) });
}

export function configureAntigravitySessionSignaturePersistence(input: { stateDir: string; fileName?: string } | null): void {
  const mod = loadAntigravitySignatureModule();
  const fn = mod?.configureAntigravitySessionSignaturePersistence;
  if (typeof fn !== 'function') {
    return;
  }
  try {
    fn(input);
  } catch {
    // best-effort only
  }
}

export function flushAntigravitySessionSignaturePersistenceSync(): void {
  const mod = loadAntigravitySignatureModule();
  const fn = mod?.flushAntigravitySessionSignaturePersistenceSync;
  if (typeof fn !== 'function') {
    return;
  }
  try {
    fn();
  } catch {
    // best-effort only
  }
}

type SnapshotHooksModule = {
  writeSnapshotViaHooks?: (options: AnyRecord) => Promise<void> | void;
};

export async function writeSnapshotViaHooks(channelOrOptions: string | AnyRecord, payload?: AnyRecord): Promise<void> {
  let hooksModule: SnapshotHooksModule | null = null;
  try {
    hooksModule = await importCoreDist<SnapshotHooksModule>('conversion/shared/snapshot-hooks');
  } catch {
    hooksModule = null;
  }
  const writer = hooksModule?.writeSnapshotViaHooks;
  if (typeof writer !== 'function') {
    return;
  }

  let options: AnyRecord | undefined;
  if (payload && typeof channelOrOptions === 'string') {
    const channelValue =
      typeof payload.channel === 'string' && payload.channel ? payload.channel : channelOrOptions;
    options = {
      ...payload,
      channel: channelValue
    };
  } else if (channelOrOptions && typeof channelOrOptions === 'object') {
    options = channelOrOptions;
  }

  if (!options) {
    return;
  }

  await writer(options);
}

type ResponsesConversationModule = {
  resumeResponsesConversation?: (
    responseId: string,
    submitPayload: AnyRecord,
    options?: { requestId?: string }
  ) => Promise<{ payload: AnyRecord; meta: AnyRecord }>;
  rebindResponsesConversationRequestId?: (oldId: string, newId: string) => void;
};

export async function resumeResponsesConversation(
  responseId: string,
  submitPayload: AnyRecord,
  options?: { requestId?: string }
): Promise<{ payload: AnyRecord; meta: AnyRecord }> {
  const mod = await importCoreDist<ResponsesConversationModule>('conversion/shared/responses-conversation-store');
  const fn = mod.resumeResponsesConversation;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resumeResponsesConversation not available');
  }
  return await fn(responseId, submitPayload, options);
}

export async function rebindResponsesConversationRequestId(oldId?: string, newId?: string): Promise<void> {
  if (!oldId || !newId || oldId === newId) {
    return;
  }
  const mod = await importCoreDist<ResponsesConversationModule>('conversion/shared/responses-conversation-store');
  const fn = mod.rebindResponsesConversationRequestId;
  if (typeof fn === 'function') {
    fn(oldId, newId);
  }
}

type ProviderResponseConversionModule = {
  convertProviderResponse?: (options: AnyRecord) => Promise<AnyRecord> | AnyRecord;
};

const cachedConvertProviderResponseByImpl: Record<LlmsImpl, ((options: AnyRecord) => Promise<AnyRecord>) | null> = {
  ts: null,
  engine: null
};

const llmsEngineShadowConfig = resolveLlmsEngineShadowConfig();

/**
 * Host/HTTP 侧统一使用的 provider 响应转换入口。
 * 封装 llmswitch-core 的 convertProviderResponse，避免在 Host 内部直接 import core 模块。
 */
export async function convertProviderResponse(options: AnyRecord): Promise<AnyRecord> {
  const subpath = 'conversion/hub/response/provider-response';

  const ensureFn = async (impl: LlmsImpl) => {
    if (!cachedConvertProviderResponseByImpl[impl]) {
      const mod = await importCoreDist<ProviderResponseConversionModule>(subpath, impl);
      const fn = mod.convertProviderResponse;
      if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] convertProviderResponse not available');
      }
      cachedConvertProviderResponseByImpl[impl] = async (opts: AnyRecord) => {
        const result = fn(opts);
        return result instanceof Promise ? await result : result;
      };
    }
    return cachedConvertProviderResponseByImpl[impl]!;
  };

  const shadowEnabled = isLlmsEngineShadowEnabledForSubpath(llmsEngineShadowConfig, 'conversion/hub/response');
  if (shadowEnabled) {
    // Fail fast: if shadow is enabled for this module, engine core must be available.
    await ensureFn('engine');
  }
  const wantsShadow = shadowEnabled && shouldRunLlmsEngineShadowForSubpath(llmsEngineShadowConfig, 'conversion/hub/response');
  if (wantsShadow) {
    const baseline = await (await ensureFn('ts'))(options);
    const requestId =
      typeof (options as AnyRecord).requestId === 'string'
        ? String((options as AnyRecord).requestId)
        : (typeof (options as AnyRecord).id === 'string' ? String((options as AnyRecord).id) : `shadow_${Date.now()}`);
    void (async () => {
      try {
        const candidate = await (await ensureFn('engine'))(options);
        await recordLlmsEngineShadowDiff({
          group: 'provider-response',
          requestId,
          subpath: 'conversion/hub/response',
          baselineImpl: 'ts',
          candidateImpl: 'engine',
          baselineOut: baseline,
          candidateOut: candidate,
          excludedComparePaths: []
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[llms-engine-shadow] provider response shadow failed:', error);
      }
    })();
    return baseline;
  }

  const impl = resolveImplForSubpath(subpath);
  return await (await ensureFn(impl))(options);
}

type SnapshotRecorderModule = {
  createSnapshotRecorder?: (context: AnyRecord, endpoint: string) => SnapshotRecorder;
};

let cachedSnapshotRecorderFactory:
  | ((context: AnyRecord, endpoint: string) => SnapshotRecorder)
  | null = null;

/**
 * 为 HubPipeline / provider 响应路径创建阶段快照记录器。
 * 内部通过 llmswitch-core 的 snapshot-recorder 模块实现。
 */
export async function createSnapshotRecorder(
  context: AnyRecord,
  endpoint: string
): Promise<SnapshotRecorder> {
  if (!cachedSnapshotRecorderFactory) {
    const mod = await importCoreDist<SnapshotRecorderModule>('conversion/hub/snapshot-recorder');
    const factory = mod.createSnapshotRecorder;
    if (typeof factory !== 'function') {
      throw new Error('[llmswitch-bridge] createSnapshotRecorder not available');
    }
    cachedSnapshotRecorderFactory = factory;
  }
  const recorder = cachedSnapshotRecorderFactory(context, endpoint) as any;
  const baseRecord = typeof recorder?.record === 'function' ? recorder.record.bind(recorder) : null;
  if (!baseRecord) {
    return recorder;
  }

  return {
    ...recorder,
    record(stage: string, payload: object) {
      baseRecord(stage, payload);
      try {
        if (!stage || typeof stage !== 'string') return;
        const p = payload as any;
        if (!p || typeof p !== 'object') return;

        if (stage.startsWith('hub_policy.')) {
          const violations = p.violations;
          if (!Array.isArray(violations) || violations.length <= 0) return;
          void writeErrorsampleJson({
            group: 'policy',
            kind: stage,
            payload: {
              kind: 'hub_policy_violation',
              timestamp: new Date().toISOString(),
              endpoint,
              stage,
              versions: {
                routecodex: buildInfo.version,
                llms: resolveLlmswitchCoreVersion(),
                node: process.version
              },
              ...(context && typeof context === 'object'
                ? {
                    requestId: (context as any).requestId,
                    providerProtocol: (context as any).providerProtocol,
                    runtime: (context as any).runtime
                  }
                : {}),
              observation: payload
            }
          }).catch(() => {});
          return;
        }

        if (stage.startsWith('hub_toolsurface.')) {
          const diffCount = typeof p.diffCount === 'number' ? p.diffCount : 0;
          if (!(diffCount > 0)) return;
          void writeErrorsampleJson({
            group: 'tool-surface',
            kind: stage,
            payload: {
              kind: 'hub_toolsurface_diff',
              timestamp: new Date().toISOString(),
              endpoint,
              stage,
              versions: {
                routecodex: buildInfo.version,
                llms: resolveLlmswitchCoreVersion(),
                node: process.version
              },
              ...(context && typeof context === 'object'
                ? {
                    requestId: (context as any).requestId,
                    providerProtocol: (context as any).providerProtocol,
                    runtime: (context as any).runtime
                  }
                : {}),
              observation: payload
            }
          }).catch(() => {});
          return;
        }

        if (stage.startsWith('hub_followup.')) {
          const diffCount = typeof p.diffCount === 'number' ? p.diffCount : 0;
          if (!(diffCount > 0)) return;
          void writeErrorsampleJson({
            group: 'followup',
            kind: stage,
            payload: {
              kind: 'hub_followup_diff',
              timestamp: new Date().toISOString(),
              endpoint,
              stage,
              versions: {
                routecodex: buildInfo.version,
                llms: resolveLlmswitchCoreVersion(),
                node: process.version
              },
              ...(context && typeof context === 'object'
                ? {
                    requestId: (context as any).requestId,
                    providerProtocol: (context as any).providerProtocol,
                    runtime: (context as any).runtime
                  }
                : {}),
              observation: payload
            }
          }).catch(() => {});
          return;
        }
      } catch {
        // best-effort only; must never break request path
      }
    }
  } as SnapshotRecorder;
}

type ResponsesSseModule = {
  ResponsesSseToJsonConverter?: new () => {
    convertSseToJson(stream: unknown, options: AnyRecord): Promise<unknown>;
  };
};

let cachedResponsesSseConverterFactory:
  | (() => { convertSseToJson(stream: unknown, options: AnyRecord): Promise<unknown> })
  | null = null;

/**
 * 创建 Responses SSE→JSON 转换器实例，供 ResponsesProvider 使用。
 */
export async function createResponsesSseToJsonConverter(): Promise<{
  convertSseToJson(stream: unknown, options: AnyRecord): Promise<unknown>;
}> {
  if (!cachedResponsesSseConverterFactory) {
    const mod = await importCoreDist<ResponsesSseModule>('sse/sse-to-json/index');
    const Ctor = mod.ResponsesSseToJsonConverter;
    if (typeof Ctor !== 'function') {
      throw new Error('[llmswitch-bridge] ResponsesSseToJsonConverter not available');
    }
    cachedResponsesSseConverterFactory = () => new Ctor();
  }
  return cachedResponsesSseConverterFactory();
}

type ProviderErrorCenterExports = {
  providerErrorCenter?: {
    emit(event: ProviderErrorEvent): void;
    subscribe?(handler: (event: ProviderErrorEvent) => void): () => void;
  };
};

let cachedProviderErrorCenter:
  | ProviderErrorCenterExports['providerErrorCenter']
  | null = null;

/**
 * ProviderErrorCenter 统一桥接入口。
 * Provider/Host 通过本函数获取 error center，避免直接 import core 模块。
 */
export async function getProviderErrorCenter(): Promise<ProviderErrorCenterExports['providerErrorCenter']> {
  if (!cachedProviderErrorCenter) {
    const mod = await importCoreDist<ProviderErrorCenterExports>('router/virtual-router/error-center');
    const center = mod.providerErrorCenter;
    if (!center) {
      throw new Error('[llmswitch-bridge] providerErrorCenter not available');
    }
    cachedProviderErrorCenter = center;
  }
  return cachedProviderErrorCenter;
}

type ProviderSuccessCenterExports = {
  providerSuccessCenter?: {
    emit(event: ProviderSuccessEvent): void;
    subscribe?(handler: (event: ProviderSuccessEvent) => void): () => void;
  };
};

let cachedProviderSuccessCenter:
  | ProviderSuccessCenterExports['providerSuccessCenter']
  | null = null;

/**
 * ProviderSuccessCenter 统一桥接入口。
 * Host 通过本函数获取 success center，避免直接 import core 模块。
 */
export async function getProviderSuccessCenter(): Promise<ProviderSuccessCenterExports['providerSuccessCenter']> {
  if (!cachedProviderSuccessCenter) {
    const mod = await importCoreDist<ProviderSuccessCenterExports>('router/virtual-router/success-center');
    const center = mod.providerSuccessCenter;
    if (!center) {
      throw new Error('[llmswitch-bridge] providerSuccessCenter not available');
    }
    cachedProviderSuccessCenter = center;
  }
  return cachedProviderSuccessCenter;
}

type StickySessionStoreExports = {
  loadRoutingInstructionStateSync?: (key: string) => unknown | null;
  saveRoutingInstructionStateAsync?: (key: string, state: unknown | null) => void;
  saveRoutingInstructionStateSync?: (key: string, state: unknown | null) => void;
};

let cachedStickySessionStore: StickySessionStoreExports | null | undefined = undefined;

function getStickySessionStoreExports(): StickySessionStoreExports | null {
  if (cachedStickySessionStore !== undefined) {
    return cachedStickySessionStore;
  }
  try {
    // NOTE: must be sync because VirtualRouter routingStateStore expects loadSync.
    // Centralized here to keep a single core import surface.
    cachedStickySessionStore = requireCoreDist<StickySessionStoreExports>('router/virtual-router/sticky-session-store');
  } catch {
    cachedStickySessionStore = null;
  }
  return cachedStickySessionStore;
}

export function loadRoutingInstructionStateSync(key: string): unknown | null {
  const mod = getStickySessionStoreExports();
  const fn = mod?.loadRoutingInstructionStateSync;
  if (typeof fn !== 'function') {
    return null;
  }
  return fn(key);
}

export function saveRoutingInstructionStateAsync(key: string, state: unknown | null): void {
  const mod = getStickySessionStoreExports();
  const fn = mod?.saveRoutingInstructionStateAsync;
  if (typeof fn !== 'function') {
    return;
  }
  fn(key, state);
}

export function saveRoutingInstructionStateSync(key: string, state: unknown | null): void {
  const mod = getStickySessionStoreExports();
  const fn = mod?.saveRoutingInstructionStateSync;
  if (typeof fn !== 'function') {
    return;
  }
  fn(key, state);
}

type SessionIdentifiers = { sessionId?: string; conversationId?: string };

type SessionIdentifiersModule = {
  extractSessionIdentifiersFromMetadata?: (meta: Record<string, unknown> | undefined) => SessionIdentifiers;
};

let cachedSessionIdentifiersModule: SessionIdentifiersModule | null | undefined = undefined;

function getSessionIdentifiersModule(): SessionIdentifiersModule | null {
  if (cachedSessionIdentifiersModule !== undefined) {
    return cachedSessionIdentifiersModule;
  }
  try {
    cachedSessionIdentifiersModule = requireCoreDist<SessionIdentifiersModule>('conversion/hub/pipeline/session-identifiers');
  } catch {
    cachedSessionIdentifiersModule = null;
  }
  return cachedSessionIdentifiersModule;
}

export function extractSessionIdentifiersFromMetadata(
  meta: Record<string, unknown> | undefined
): SessionIdentifiers {
  const mod = getSessionIdentifiersModule();
  const fn = mod?.extractSessionIdentifiersFromMetadata;
  if (typeof fn !== 'function') {
    return {};
  }
  try {
    return fn(meta);
  } catch {
    return {};
  }
}

type StatsCenterLike = {
  recordProviderUsage(ev: unknown): void;
};

type StatsCenterModule = {
  getStatsCenter?: () => StatsCenterLike;
};

let cachedStatsCenter: StatsCenterLike | null | undefined = undefined;

export function getStatsCenterSafe(): StatsCenterLike {
  if (cachedStatsCenter) {
    return cachedStatsCenter;
  }
  if (cachedStatsCenter === null) {
    return { recordProviderUsage: () => {} };
  }
  try {
    const mod = requireCoreDist<StatsCenterModule>('telemetry/stats-center');
    const fn = mod?.getStatsCenter;
    const center = typeof fn === 'function' ? fn() : null;
    if (center && typeof center.recordProviderUsage === 'function') {
      cachedStatsCenter = center;
      return center;
    }
  } catch {
    // fall through
  }
  cachedStatsCenter = null;
  return { recordProviderUsage: () => {} };
}

export function getLlmsStatsSnapshot(): unknown | null {
  try {
    const mod = requireCoreDist<{ getStatsCenter?: () => { getSnapshot?: () => unknown } }>('telemetry/stats-center');
    const get = mod?.getStatsCenter;
    const center = typeof get === 'function' ? get() : null;
    const snap = center && typeof center === 'object' ? (center as any).getSnapshot : null;
    return typeof snap === 'function' ? snap.call(center) : null;
  } catch {
    return null;
  }
}

type VirtualRouterBootstrapModule = {
  bootstrapVirtualRouterConfig?: (input: AnyRecord) => AnyRecord;
};

/**
 * 通过 llmswitch-core 的 bootstrapVirtualRouterConfig 预处理 Virtual Router 配置。
 */
export async function bootstrapVirtualRouterConfig(input: AnyRecord): Promise<AnyRecord> {
  const mod = await importCoreDist<VirtualRouterBootstrapModule>('router/virtual-router/bootstrap');
  const fn = mod.bootstrapVirtualRouterConfig;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] bootstrapVirtualRouterConfig not available');
  }
  return fn(input);
}

type ClockTaskStoreModule = {
  resolveClockConfig?: (input: unknown) => unknown | null;
  reserveDueTasksForRequest?: (args: {
    reservationId: string;
    sessionId: string;
    config: unknown;
    requestId?: string;
  }) => Promise<{ reservation: unknown | null; injectText?: string }>;
  commitClockReservation?: (reservation: unknown, config: unknown) => Promise<void>;
  listClockSessionIds?: () => Promise<string[]>;
  listClockTasks?: (sessionId: string, config: unknown) => Promise<unknown[]>;
  scheduleClockTasks?: (sessionId: string, items: unknown[], config: unknown) => Promise<unknown[]>;
  updateClockTask?: (sessionId: string, taskId: string, patch: Record<string, unknown>, config: unknown) => Promise<unknown | null>;
  cancelClockTask?: (sessionId: string, taskId: string, config: unknown) => Promise<boolean>;
  clearClockTasks?: (sessionId: string, config: unknown) => Promise<number>;
};

type ClockTaskStoreLegacyTasksModule = Pick<
  ClockTaskStoreModule,
  | 'reserveDueTasksForRequest'
  | 'commitClockReservation'
  | 'listClockSessionIds'
  | 'listClockTasks'
  | 'scheduleClockTasks'
  | 'updateClockTask'
  | 'cancelClockTask'
  | 'clearClockTasks'
>;

type ClockTaskStoreLegacyConfigModule = Pick<ClockTaskStoreModule, 'resolveClockConfig'>;

let cachedClockTaskStoreModule: ClockTaskStoreModule | null | undefined = undefined;
let clockTaskStoreLastLoadAttemptAtMs = 0;
let hasLoggedClockTaskStoreLoadFailure = false;

const CLOCK_TASK_STORE_RETRY_INTERVAL_MS = 30_000;

async function tryLoadClockTaskStoreModule(): Promise<ClockTaskStoreModule | null> {
  try {
    return await importCoreDist<ClockTaskStoreModule>('servertool/clock/task-store');
  } catch {
    // fallback to legacy split exports
  }

  try {
    const [tasksModule, configModule] = await Promise.all([
      importCoreDist<ClockTaskStoreLegacyTasksModule>('servertool/clock/tasks'),
      importCoreDist<ClockTaskStoreLegacyConfigModule>('servertool/clock/config')
    ]);
    return {
      ...tasksModule,
      resolveClockConfig: configModule.resolveClockConfig
    };
  } catch {
    return null;
  }
}

async function getClockTaskStoreModuleSafe(): Promise<ClockTaskStoreModule | null> {
  if (cachedClockTaskStoreModule) {
    return cachedClockTaskStoreModule;
  }

  const now = Date.now();
  if (
    cachedClockTaskStoreModule === null &&
    now - clockTaskStoreLastLoadAttemptAtMs < CLOCK_TASK_STORE_RETRY_INTERVAL_MS
  ) {
    return null;
  }

  clockTaskStoreLastLoadAttemptAtMs = now;
  const loaded = await tryLoadClockTaskStoreModule();
  if (loaded) {
    cachedClockTaskStoreModule = loaded;
    hasLoggedClockTaskStoreLoadFailure = false;
    return loaded;
  }

  cachedClockTaskStoreModule = null;
  if (!hasLoggedClockTaskStoreLoadFailure) {
    hasLoggedClockTaskStoreLoadFailure = true;
    console.warn(
      '[llmswitch-bridge] clock task-store module unavailable; clock daemon inject/tasks are temporarily disabled. Please ensure @jsonstudio/llms dist is built and installed.'
    );
  }

  return null;
}

export async function resolveClockConfigSnapshot(input: unknown): Promise<unknown | null> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.resolveClockConfig;
  if (typeof fn !== 'function') {
    return null;
  }
  try {
    return fn(input) ?? null;
  } catch {
    return null;
  }
}

export async function reserveClockDueTasks(args: {
  reservationId: string;
  sessionId: string;
  config: unknown;
  requestId?: string;
}): Promise<{ reservation: unknown | null; injectText?: string }> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.reserveDueTasksForRequest;
  if (typeof fn !== 'function') {
    return { reservation: null };
  }
  try {
    return await fn(args);
  } catch {
    return { reservation: null };
  }
}

export async function commitClockDueReservation(args: { reservation: unknown; config: unknown }): Promise<void> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.commitClockReservation;
  if (typeof fn !== 'function') {
    return;
  }
  try {
    await fn(args.reservation, args.config);
  } catch {
    // best-effort only
  }
}

export async function listClockSessionIdsSnapshot(): Promise<string[]> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.listClockSessionIds;
  if (typeof fn !== 'function') {
    return [];
  }
  try {
    const out = await fn();
    return Array.isArray(out) ? out.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : [];
  } catch {
    return [];
  }
}

export async function listClockTasksSnapshot(args: { sessionId: string; config: unknown }): Promise<unknown[]> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.listClockTasks;
  if (typeof fn !== 'function') {
    return [];
  }
  try {
    const out = await fn(args.sessionId, args.config);
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

export async function scheduleClockTasksSnapshot(args: { sessionId: string; items: unknown[]; config: unknown }): Promise<unknown[]> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.scheduleClockTasks;
  if (typeof fn !== 'function') {
    return [];
  }
  try {
    const out = await fn(args.sessionId, Array.isArray(args.items) ? args.items : [], args.config);
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

export async function updateClockTaskSnapshot(args: {
  sessionId: string;
  taskId: string;
  patch: Record<string, unknown>;
  config: unknown;
}): Promise<unknown | null> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.updateClockTask;
  if (typeof fn !== 'function') {
    return null;
  }
  try {
    return await fn(args.sessionId, args.taskId, args.patch, args.config);
  } catch {
    return null;
  }
}

export async function cancelClockTaskSnapshot(args: { sessionId: string; taskId: string; config: unknown }): Promise<boolean> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.cancelClockTask;
  if (typeof fn !== 'function') {
    return false;
  }
  try {
    return Boolean(await fn(args.sessionId, args.taskId, args.config));
  } catch {
    return false;
  }
}

export async function clearClockTasksSnapshot(args: { sessionId: string; config: unknown }): Promise<number> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.clearClockTasks;
  if (typeof fn !== 'function') {
    return 0;
  }
  try {
    const removed = await fn(args.sessionId, args.config);
    return Number.isFinite(Number(removed)) ? Math.max(0, Math.floor(Number(removed))) : 0;
  } catch {
    return 0;
  }
}


type HubPipelineModule = {
  HubPipeline?: new (config: AnyRecord) => AnyRecord;
};

type HubPipelineCtorAny = new (config: AnyRecord) => AnyRecord;

const cachedHubPipelineCtorByImpl: Record<LlmsImpl, HubPipelineCtorAny | null> = {
  ts: null,
  engine: null
};

/**
 * 获取 HubPipeline 构造函数，供 Host 创建 HubPipeline 实例。
 */
export async function getHubPipelineCtor(): Promise<HubPipelineCtorAny> {
  const impl = resolveImplForSubpath('conversion/hub/pipeline/hub-pipeline');
  if (!cachedHubPipelineCtorByImpl[impl]) {
    const mod = await importCoreDist<HubPipelineModule>('conversion/hub/pipeline/hub-pipeline', impl);
    const Ctor = mod.HubPipeline;
    if (typeof Ctor !== 'function') {
      throw new Error('[llmswitch-bridge] HubPipeline constructor not available');
    }
    cachedHubPipelineCtorByImpl[impl] = Ctor;
  }
  return cachedHubPipelineCtorByImpl[impl]!;
}

export async function getHubPipelineCtorForImpl(impl: LlmsImpl): Promise<HubPipelineCtorAny> {
  if (!cachedHubPipelineCtorByImpl[impl]) {
    const mod = await importCoreDist<HubPipelineModule>('conversion/hub/pipeline/hub-pipeline', impl);
    const Ctor = mod.HubPipeline;
    if (typeof Ctor !== 'function') {
      throw new Error('[llmswitch-bridge] HubPipeline constructor not available');
    }
    cachedHubPipelineCtorByImpl[impl] = Ctor;
  }
  return cachedHubPipelineCtorByImpl[impl]!;
}

function resolveBaseDir(): string {
  const env = String(process.env.ROUTECODEX_BASEDIR || process.env.RCC_BASEDIR || '').trim();
  if (env) {
    return env;
  }
  try {
    const __filename = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(__filename), '../../..');
  } catch {
    return process.cwd();
  }
}
