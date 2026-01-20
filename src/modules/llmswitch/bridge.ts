import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { importCoreModule } from './core-loader.js';
import type { ProviderErrorEvent } from '@jsonstudio/llms/dist/router/virtual-router/types.js';
import { writeErrorsampleJson } from '../../utils/errorsamples.js';
import { buildInfo } from '../../build-info.js';
import { resolveLlmswitchCoreVersion } from '../../utils/runtime-versions.js';

type AnyRecord = Record<string, unknown>;
type SnapshotRecorder = unknown;

// 单一桥接模块：这是全项目中唯一允许直接 import llmswitch-core 的地方。
// 其它代码（pipeline/provider/server/virtual-router/snapshot）都只能通过这里暴露的统一接口访问 llmswitch-core。
// 默认引用 @jsonstudio/llms（来自 npm 发布版本）。仓库开发场景可通过 scripts/link-llmswitch.mjs 将该依赖 link 到本地 sharedmodule。

export type { ProviderErrorEvent } from '@jsonstudio/llms/dist/router/virtual-router/types.js';
export type { ProviderUsageEvent } from '@jsonstudio/llms';

const require = createRequire(import.meta.url);

async function importCoreDist<TModule extends object = AnyRecord>(subpath: string): Promise<TModule> {
  try {
    return await importCoreModule<TModule>(subpath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[llmswitch-bridge] Unable to load core module "${subpath}". 请确认 @jsonstudio/llms 依赖已安装（npm install）。${detail ? ` (${detail})` : ''}`
    );
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

let cachedConvertProviderResponse:
  | ((options: AnyRecord) => Promise<AnyRecord>)
  | null = null;

/**
 * Host/HTTP 侧统一使用的 provider 响应转换入口。
 * 封装 llmswitch-core 的 convertProviderResponse，避免在 Host 内部直接 import core 模块。
 */
export async function convertProviderResponse(options: AnyRecord): Promise<AnyRecord> {
  if (!cachedConvertProviderResponse) {
    const mod = await importCoreDist<ProviderResponseConversionModule>('conversion/hub/response/provider-response');
    const fn = mod.convertProviderResponse;
    if (typeof fn !== 'function') {
      throw new Error('[llmswitch-bridge] convertProviderResponse not available');
    }
    cachedConvertProviderResponse = async (opts: AnyRecord) => {
      const result = fn(opts);
      return result instanceof Promise ? await result : result;
    };
  }
  return await cachedConvertProviderResponse(options);
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

type StickySessionStoreExports = {
  loadRoutingInstructionStateSync?: (key: string) => unknown | null;
  saveRoutingInstructionStateAsync?: (key: string, state: unknown | null) => void;
};

let cachedStickySessionStore: StickySessionStoreExports | null | undefined = undefined;

function getStickySessionStoreExports(): StickySessionStoreExports | null {
  if (cachedStickySessionStore !== undefined) {
    return cachedStickySessionStore;
  }
  try {
    // NOTE: must be sync because VirtualRouter routingStateStore expects loadSync.
    // Centralized here to keep a single core import surface.
    cachedStickySessionStore = require('@jsonstudio/llms/dist/router/virtual-router/sticky-session-store.js') as StickySessionStoreExports;
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
    cachedSessionIdentifiersModule = require(
      '@jsonstudio/llms/dist/conversion/hub/pipeline/session-identifiers.js'
    ) as SessionIdentifiersModule;
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
    const mod = require('@jsonstudio/llms/dist/telemetry/stats-center.js') as StatsCenterModule;
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

type HubPipelineModule = {
  HubPipeline?: new (config: AnyRecord) => AnyRecord;
};

type HubPipelineCtorAny = new (config: AnyRecord) => AnyRecord;

let cachedHubPipelineCtor: HubPipelineCtorAny | null = null;

/**
 * 获取 HubPipeline 构造函数，供 Host 创建 HubPipeline 实例。
 */
export async function getHubPipelineCtor(): Promise<HubPipelineCtorAny> {
  if (!cachedHubPipelineCtor) {
    const mod = await importCoreDist<HubPipelineModule>('conversion/hub/pipeline/hub-pipeline');
    const Ctor = mod.HubPipeline;
    if (typeof Ctor !== 'function') {
      throw new Error('[llmswitch-bridge] HubPipeline constructor not available');
    }
    cachedHubPipelineCtor = Ctor;
  }
  return cachedHubPipelineCtor;
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
