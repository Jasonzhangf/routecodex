/**
 * RouteCodex LLM Switch Bridge
 *
 * Single bridge module for llmswitch-core integration.
 * All core imports are centralized here to avoid scattered dependencies.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { x7eGate } from '../../server/runtime/http-server/daemon-admin/routecodex-x7e-gate.js';
import type { ProviderErrorEvent, ProviderSuccessEvent } from '@jsonstudio/llms/dist/router/virtual-router/types.js';

// Re-export types from core
export type { ProviderErrorEvent } from '@jsonstudio/llms/dist/router/virtual-router/types.js';
export type { ProviderSuccessEvent } from '@jsonstudio/llms/dist/router/virtual-router/types.js';
export type { ProviderUsageEvent } from '@jsonstudio/llms';
export type {
  StaticQuotaConfig,
  QuotaState,
  QuotaStore,
  QuotaStoreSnapshot
} from '@jsonstudio/llms/dist/quota/index.js';

// Import utilities for internal use (also re-exported below)
import {
  importCoreDist,
  requireCoreDist,
  resolveImplForSubpath,
  type AnyRecord,
  type LlmsImpl
} from './bridge/module-loader.js';

// Re-export from bridge submodules
export {
  createSnapshotRecorder,
  type SnapshotRecorder
} from './bridge/snapshot-recorder.js';
export { convertProviderResponse } from './bridge/response-converter.js';
export {
  warmupAntigravitySessionSignatureModule,
  extractAntigravityGeminiSessionId,
  cacheAntigravitySessionSignature,
  getAntigravityLatestSignatureSessionIdForAlias,
  lookupAntigravitySessionSignatureEntry,
  invalidateAntigravitySessionSignature,
  resetAntigravitySessionSignatureCachesForTests,
  configureAntigravitySessionSignaturePersistence,
  flushAntigravitySessionSignaturePersistenceSync
} from './bridge/antigravity-signature.js';
export {
  importCoreDist,
  requireCoreDist,
  resolveImplForSubpath,
  type AnyRecord,
  type LlmsImpl
} from './bridge/module-loader.js';

// ============================================================================
// Quota Module
// ============================================================================

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

// ============================================================================
// Snapshot Hooks
// ============================================================================

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
    options = { ...payload, channel: channelValue };
  } else if (channelOrOptions && typeof channelOrOptions === 'object') {
    options = channelOrOptions;
  }

  if (!options) {
    return;
  }

  await writer(options);
}

// ============================================================================
// Responses Conversation
// ============================================================================

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

// ============================================================================
// Responses SSE Converter
// ============================================================================

type ResponsesSseModule = {
  ResponsesSseToJsonConverter?: new () => {
    convertSseToJson(stream: unknown, options: AnyRecord): Promise<unknown>;
  };
};

let cachedResponsesSseConverterFactory:
  | (() => { convertSseToJson(stream: unknown, options: AnyRecord): Promise<unknown> })
  | null = null;

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

// ============================================================================
// Error/Success Centers
// ============================================================================

type ProviderErrorCenterExports = {
  providerErrorCenter?: {
    emit(event: ProviderErrorEvent): void;
    subscribe?(handler: (event: ProviderErrorEvent) => void): () => void;
  };
};

let cachedProviderErrorCenter: ProviderErrorCenterExports['providerErrorCenter'] | null = null;

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

let cachedProviderSuccessCenter: ProviderSuccessCenterExports['providerSuccessCenter'] | null = null;

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

// ============================================================================
// Sticky Session Store
// ============================================================================

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

// ============================================================================
// Session Identifiers
// ============================================================================

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

export function extractSessionIdentifiersFromMetadata(meta: Record<string, unknown> | undefined): SessionIdentifiers {
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

// ============================================================================
// Stats Center
// ============================================================================

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

// ============================================================================
// Virtual Router Bootstrap
// ============================================================================

type VirtualRouterBootstrapModule = {
  bootstrapVirtualRouterConfig?: (input: AnyRecord) => AnyRecord;
};

export async function bootstrapVirtualRouterConfig(input: AnyRecord): Promise<AnyRecord> {
  const mod = await importCoreDist<VirtualRouterBootstrapModule>('router/virtual-router/bootstrap');
  const fn = mod.bootstrapVirtualRouterConfig;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] bootstrapVirtualRouterConfig not available');
  }
  return fn(input);
}

// ============================================================================
// Clock Task Store
// ============================================================================

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

type ClockTaskStoreLegacyTasksModule = Pick<ClockTaskStoreModule,
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
    return { ...tasksModule, resolveClockConfig: configModule.resolveClockConfig };
  } catch {
    return null;
  }
}

async function getClockTaskStoreModuleSafe(): Promise<ClockTaskStoreModule | null> {
  if (cachedClockTaskStoreModule) {
    return cachedClockTaskStoreModule;
  }

  const now = Date.now();
  if (cachedClockTaskStoreModule === null && now - clockTaskStoreLastLoadAttemptAtMs < CLOCK_TASK_STORE_RETRY_INTERVAL_MS) {
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
      '[llmswitch-bridge] clock task-store module unavailable; clock daemon inject/tasks are temporarily disabled.'
    );
  }

  return null;
}

export async function resolveClockConfigSnapshot(input: unknown): Promise<unknown | null> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.resolveClockConfig;
  if (typeof fn !== 'function') return null;
  try { return fn(input) ?? null; } catch { return null; }
}

export async function reserveClockDueTasks(args: {
  reservationId: string;
  sessionId: string;
  config: unknown;
  requestId?: string;
}): Promise<{ reservation: unknown | null; injectText?: string }> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.reserveDueTasksForRequest;
  if (typeof fn !== 'function') return { reservation: null };
  try { return await fn(args); } catch { return { reservation: null }; }
}

export async function commitClockDueReservation(args: { reservation: unknown; config: unknown }): Promise<void> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.commitClockReservation;
  if (typeof fn !== 'function') return;
  try { await fn(args.reservation, args.config); } catch { /* best-effort */ }
}

export async function listClockSessionIdsSnapshot(): Promise<string[]> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.listClockSessionIds;
  if (typeof fn !== 'function') return [];
  try {
    const out = await fn();
    return Array.isArray(out) ? out.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : [];
  } catch { return []; }
}

export async function listClockTasksSnapshot(args: { sessionId: string; config: unknown }): Promise<unknown[]> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.listClockTasks;
  if (typeof fn !== 'function') return [];
  try { const out = await fn(args.sessionId, args.config); return Array.isArray(out) ? out : []; } catch { return []; }
}

export async function scheduleClockTasksSnapshot(args: { sessionId: string; items: unknown[]; config: unknown }): Promise<unknown[]> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.scheduleClockTasks;
  if (typeof fn !== 'function') return [];
  try { const out = await fn(args.sessionId, Array.isArray(args.items) ? args.items : [], args.config); return Array.isArray(out) ? out : []; } catch { return []; }
}

export async function updateClockTaskSnapshot(args: {
  sessionId: string; taskId: string; patch: Record<string, unknown>; config: unknown;
}): Promise<unknown | null> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.updateClockTask;
  if (typeof fn !== 'function') return null;
  try { return await fn(args.sessionId, args.taskId, args.patch, args.config); } catch { return null; }
}

export async function cancelClockTaskSnapshot(args: { sessionId: string; taskId: string; config: unknown }): Promise<boolean> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.cancelClockTask;
  if (typeof fn !== 'function') return false;
  try { return Boolean(await fn(args.sessionId, args.taskId, args.config)); } catch { return false; }
}

export async function clearClockTasksSnapshot(args: { sessionId: string; config: unknown }): Promise<number> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.clearClockTasks;
  if (typeof fn !== 'function') return 0;
  try {
    const removed = await fn(args.sessionId, args.config);
    return Number.isFinite(Number(removed)) ? Math.max(0, Math.floor(Number(removed))) : 0;
  } catch { return 0; }
}

// ============================================================================
// Hub Pipeline
// ============================================================================

type HubPipelineModule = {
  HubPipeline?: new (config: AnyRecord) => AnyRecord;
};

type HubPipelineCtorAny = new (config: AnyRecord) => AnyRecord;

const cachedHubPipelineCtorByImpl: Record<LlmsImpl, HubPipelineCtorAny | null> = {
  ts: null,
  engine: null
};

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

// ============================================================================
// Base Directory Resolution
// ============================================================================

export function resolveBaseDir(): string {
  const env = String(process.env.ROUTECODEX_BASEDIR || process.env.RCC_BASEDIR || '').trim();
  if (env) return env;
  try {
    const __filename = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(__filename), '../../..');
  } catch {
    return process.cwd();
  }
}
