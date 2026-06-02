/**
 * Native Binding Exports Bridge
 *
 * Thin wrappers around llmswitch-core native bindings.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { importCoreDist, requireCoreDist, resolveCoreModulePath, type AnyRecord } from './module-loader.js';

type NativeFailureClassification = unknown;
type NativeFailurePolicyModule = {
  classifyProviderFailure?: (
    statusCode: number | undefined,
    errorCode: string | undefined,
    upstreamCode: string | undefined,
    isNetworkError: boolean,
  ) => string;
  computeBackoffMsNative?: (
    classification: NativeFailureClassification,
    attempt: number,
    baseMs: number,
    maxMs: number
  ) => number;
  getNetworkErrorCodes?: () => string[];
  isBlockingRecoverableNative?: (
    classification: NativeFailureClassification,
    stage: string | undefined
  ) => boolean;
  shouldRetryNative?: (
    classification: NativeFailureClassification,
    attempt: number,
    maxAttempts: number
  ) => boolean;
};

type NativeSharedConversionSemantics = {
  mapChatToolsToBridgeWithNative?: (rawTools: unknown) => Array<Record<string, unknown>>;
  injectMcpToolsForChatWithNative?: (tools: unknown[] | undefined, discoveredServers: string[]) => unknown[];
  injectMcpToolsForResponsesWithNative?: (tools: unknown[] | undefined, discoveredServers: string[]) => unknown[];
  normalizeAssistantTextToToolCallsWithNative?: (
    message: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Record<string, unknown>;
  planResponsesHandlerEntryWithNative?: (
    payload: unknown,
    entryEndpoint?: string,
    responseIdFromPath?: string
  ) => { mode: 'none' | 'submit_tool_outputs' | 'scope_materialize'; responseId?: string; payload: Record<string, unknown> };
};

type NativeChatProcessNodeResultSemantics = {
  deriveFinishReasonJson?: (bodyJson: string) => string;
  isToolCallContinuationResponseJson?: (bodyJson: string) => boolean;
};

type NativeHubPipelineRespSemantics = {
  buildAnthropicResponseFromChatWithNative?: (
    chatResponse: unknown,
    aliasMap?: Record<string, string>
  ) => Record<string, unknown>;
};

type FollowupSanitizeModule = {
  sanitizeFollowupText?: (raw: unknown) => string;
};

type NativeHubBridgePolicySemantics = {
  sanitizeProviderOutboundPayloadWithNative?: (input: {
    protocol?: string;
    compatibilityProfile?: string;
    payload: Record<string, unknown>;
  }) => Record<string, unknown>;
};

let cachedSharedSemantics: NativeSharedConversionSemantics | null | undefined;
let cachedRespSemantics: NativeHubPipelineRespSemantics | null | undefined;
let cachedFollowupSanitize: FollowupSanitizeModule | null | undefined;
let cachedFailurePolicyModule: NativeFailurePolicyModule | null | undefined;
let cachedHubBridgePolicySemantics: NativeHubBridgePolicySemantics | null | undefined;
let cachedChatProcessNodeResultSemantics: NativeChatProcessNodeResultSemantics | null | undefined;
let sharedBindingsChecked: boolean | undefined;
let respBindingsChecked: boolean | undefined;

function getFailurePolicyModule(): NativeFailurePolicyModule {
  if (cachedFailurePolicyModule !== undefined) {
    if (!cachedFailurePolicyModule) {
      throw new Error('[llmswitch-bridge] native-failure-policy not available');
    }
    return cachedFailurePolicyModule;
  }
  try {
    cachedFailurePolicyModule = requireCoreDist<NativeFailurePolicyModule>(
      'router/virtual-router/engine-selection/native-failure-policy'
    );
  } catch {
    cachedFailurePolicyModule = null;
  }
  if (!cachedFailurePolicyModule) {
    throw new Error('[llmswitch-bridge] native-failure-policy not available');
  }
  return cachedFailurePolicyModule;
}

async function assertSharedBindings(): Promise<void> {
  if (sharedBindingsChecked) {
    return;
  }
  const shared = await getSharedConversionSemantics();
  const missing: string[] = [];
  if (typeof shared.mapChatToolsToBridgeWithNative !== 'function') {
    missing.push('mapChatToolsToBridgeJson');
  }
  if (typeof shared.injectMcpToolsForChatWithNative !== 'function') {
    missing.push('injectMcpToolsForChatJson');
  }
  if (typeof shared.injectMcpToolsForResponsesWithNative !== 'function') {
    missing.push('injectMcpToolsForResponsesJson');
  }
  if (typeof shared.normalizeAssistantTextToToolCallsWithNative !== 'function') {
    missing.push('normalizeAssistantTextToToolCallsJson');
  }
  if (typeof shared.planResponsesHandlerEntryWithNative !== 'function') {
    missing.push('planResponsesHandlerEntryJson');
  }
  if (missing.length > 0) {
    throw new Error(`[llmswitch-bridge] native shared bindings missing: ${missing.join(', ')}`);
  }
  sharedBindingsChecked = true;
}

async function assertRespBindings(): Promise<void> {
  if (respBindingsChecked) {
    return;
  }
  const resp = await getRespSemantics();
  const missing: string[] = [];
  if (typeof resp.buildAnthropicResponseFromChatWithNative !== 'function') {
    missing.push('buildAnthropicResponseFromChatJson');
  }
  if (missing.length > 0) {
    throw new Error(`[llmswitch-bridge] native resp bindings missing: ${missing.join(', ')}`);
  }
  respBindingsChecked = true;
}

async function getSharedConversionSemantics(): Promise<NativeSharedConversionSemantics> {
  if (cachedSharedSemantics !== undefined) {
    if (!cachedSharedSemantics) {
      throw new Error('[llmswitch-bridge] native-shared-conversion-semantics not available');
    }
    return cachedSharedSemantics;
  }
  try {
    cachedSharedSemantics = await importCoreDist<NativeSharedConversionSemantics>(
      'router/virtual-router/engine-selection/native-shared-conversion-semantics'
    );
  } catch {
    cachedSharedSemantics = null;
  }
  if (!cachedSharedSemantics) {
    throw new Error('[llmswitch-bridge] native-shared-conversion-semantics not available');
  }
  return cachedSharedSemantics;
}

async function getRespSemantics(): Promise<NativeHubPipelineRespSemantics> {
  if (cachedRespSemantics !== undefined) {
    if (!cachedRespSemantics) {
      throw new Error('[llmswitch-bridge] native-hub-pipeline-resp-semantics not available');
    }
    return cachedRespSemantics;
  }
  try {
    cachedRespSemantics = await importCoreDist<NativeHubPipelineRespSemantics>(
      'router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics'
    );
  } catch {
    cachedRespSemantics = null;
  }
  if (!cachedRespSemantics) {
    throw new Error('[llmswitch-bridge] native-hub-pipeline-resp-semantics not available');
  }
  return cachedRespSemantics;
}

async function getFollowupSanitizeModule(): Promise<FollowupSanitizeModule> {
  if (cachedFollowupSanitize !== undefined) {
    if (!cachedFollowupSanitize) {
      throw new Error('[llmswitch-bridge] followup-sanitize not available');
    }
    return cachedFollowupSanitize;
  }
  try {
    cachedFollowupSanitize = await importCoreDist<FollowupSanitizeModule>('servertool/handlers/followup-sanitize');
  } catch {
    cachedFollowupSanitize = null;
  }
  if (!cachedFollowupSanitize) {
    throw new Error('[llmswitch-bridge] followup-sanitize not available');
  }
  return cachedFollowupSanitize;
}

async function getHubBridgePolicySemantics(): Promise<NativeHubBridgePolicySemantics> {
  if (cachedHubBridgePolicySemantics !== undefined) {
    if (!cachedHubBridgePolicySemantics) {
      throw new Error('[llmswitch-bridge] native-hub-bridge-policy-semantics not available');
    }
    return cachedHubBridgePolicySemantics;
  }
  try {
    cachedHubBridgePolicySemantics = await importCoreDist<NativeHubBridgePolicySemantics>(
      'router/virtual-router/engine-selection/native-hub-bridge-policy-semantics'
    );
  } catch {
    cachedHubBridgePolicySemantics = null;
  }
  if (!cachedHubBridgePolicySemantics) {
    throw new Error('[llmswitch-bridge] native-hub-bridge-policy-semantics not available');
  }
  return cachedHubBridgePolicySemantics;
}

function getChatProcessNodeResultSemantics(): NativeChatProcessNodeResultSemantics {
  if (cachedChatProcessNodeResultSemantics !== undefined) {
    if (!cachedChatProcessNodeResultSemantics) {
      throw new Error('[llmswitch-bridge] native-chat-process-node-result-semantics not available');
    }
    return cachedChatProcessNodeResultSemantics;
  }
  try {
    const wrapperPath = resolveCoreModulePath(
      'router/virtual-router/engine-selection/native-chat-process-node-result-semantics'
    );
    const nativePath = path.resolve(wrapperPath, '..', '..', '..', '..', 'native', 'router_hotpath_napi.node');
    cachedChatProcessNodeResultSemantics = createRequire(wrapperPath)(
      nativePath
    );
  } catch {
    cachedChatProcessNodeResultSemantics = null;
  }
  if (!cachedChatProcessNodeResultSemantics) {
    throw new Error('[llmswitch-bridge] native-chat-process-node-result-semantics not available');
  }
  return cachedChatProcessNodeResultSemantics;
}

export async function mapChatToolsToBridgeJson(rawTools: unknown): Promise<AnyRecord[]> {
  await assertSharedBindings();
  const mod = await getSharedConversionSemantics();
  const fn = mod.mapChatToolsToBridgeWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] mapChatToolsToBridgeJson not available');
  }
  return fn(rawTools) as AnyRecord[];
}

export async function injectMcpToolsForChatJson(
  tools: unknown[] | undefined,
  discoveredServers: string[]
): Promise<AnyRecord[]> {
  await assertSharedBindings();
  const mod = await getSharedConversionSemantics();
  const fn = mod.injectMcpToolsForChatWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] injectMcpToolsForChatJson not available');
  }
  return fn(Array.isArray(tools) ? tools : [], Array.isArray(discoveredServers) ? discoveredServers : []) as AnyRecord[];
}

export async function injectMcpToolsForResponsesJson(
  tools: unknown[] | undefined,
  discoveredServers: string[]
): Promise<AnyRecord[]> {
  await assertSharedBindings();
  const mod = await getSharedConversionSemantics();
  const fn = mod.injectMcpToolsForResponsesWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] injectMcpToolsForResponsesJson not available');
  }
  return fn(Array.isArray(tools) ? tools : [], Array.isArray(discoveredServers) ? discoveredServers : []) as AnyRecord[];
}

export async function normalizeAssistantTextToToolCallsJson(
  message: Record<string, unknown>,
  options?: Record<string, unknown>
): Promise<AnyRecord> {
  await assertSharedBindings();
  const mod = await getSharedConversionSemantics();
  const fn = mod.normalizeAssistantTextToToolCallsWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] normalizeAssistantTextToToolCallsJson not available');
  }
  return fn(message, options) as AnyRecord;
}

export async function planResponsesHandlerEntry(
  payload: unknown,
  entryEndpoint?: string,
  responseIdFromPath?: string
): Promise<{ mode: 'none' | 'submit_tool_outputs' | 'scope_materialize'; responseId?: string; payload: AnyRecord }> {
  await assertSharedBindings();
  const mod = await getSharedConversionSemantics();
  const fn = mod.planResponsesHandlerEntryWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] planResponsesHandlerEntryJson not available');
  }
  return fn(payload, entryEndpoint, responseIdFromPath) as { mode: 'none' | 'submit_tool_outputs' | 'scope_materialize'; responseId?: string; payload: AnyRecord };
}

export async function buildAnthropicResponseFromChatJson(
  chatResponse: unknown,
  aliasMap?: Record<string, string>
): Promise<AnyRecord> {
  await assertRespBindings();
  const mod = await getRespSemantics();
  const fn = mod.buildAnthropicResponseFromChatWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] buildAnthropicResponseFromChatJson not available');
  }
  return fn(chatResponse, aliasMap) as AnyRecord;
}

export async function sanitizeFollowupText(raw: unknown): Promise<string> {
  const mod = await getFollowupSanitizeModule();
  const fn = mod.sanitizeFollowupText;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] sanitizeFollowupText not available');
  }
  return fn(raw);
}

export async function sanitizeProviderOutboundPayload(input: {
  protocol?: string;
  compatibilityProfile?: string;
  payload: Record<string, unknown>;
}): Promise<AnyRecord> {
  const mod = await getHubBridgePolicySemantics();
  const fn = mod.sanitizeProviderOutboundPayloadWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] sanitizeProviderOutboundPayloadWithNative not available');
  }
  return fn(input) as AnyRecord;
}

export function classifyProviderFailure(
  statusCode: number | undefined,
  errorCode: string | undefined,
  upstreamCode: string | undefined,
  isNetworkError: boolean,
): string {
  const fn = getFailurePolicyModule().classifyProviderFailure;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] classifyProviderFailure not available');
  }
  return fn(statusCode, errorCode, upstreamCode, isNetworkError);
}

export function deriveFinishReasonNative(body: unknown): string | undefined {
  const fn = getChatProcessNodeResultSemantics().deriveFinishReasonJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] deriveFinishReasonJson not available');
  }
  const raw = fn(JSON.stringify(body ?? null));
  const parsed = JSON.parse(raw) as unknown;
  return typeof parsed === 'string' ? parsed : undefined;
}

export function isToolCallContinuationResponseNative(body: unknown): boolean {
  const fn = getChatProcessNodeResultSemantics().isToolCallContinuationResponseJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] isToolCallContinuationResponseJson not available');
  }
  return Boolean(fn(JSON.stringify(body ?? null)));
}

export function isBlockingRecoverableNative(
  classification: NativeFailureClassification,
  stage: string | undefined
): boolean {
  const fn = getFailurePolicyModule().isBlockingRecoverableNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] isBlockingRecoverableNative not available');
  }
  return fn(classification, stage);
}

export function shouldRetryNative(
  classification: NativeFailureClassification,
  attempt: number,
  maxAttempts: number
): boolean {
  const fn = getFailurePolicyModule().shouldRetryNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] shouldRetryNative not available');
  }
  return fn(classification, attempt, maxAttempts);
}

export function computeBackoffMsNative(
  classification: NativeFailureClassification,
  attempt: number,
  baseMs: number,
  maxMs: number
): number {
  const fn = getFailurePolicyModule().computeBackoffMsNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] computeBackoffMsNative not available');
  }
  return fn(classification, attempt, baseMs, maxMs);
}

export function getNetworkErrorCodes(): string[] {
  const fn = getFailurePolicyModule().getNetworkErrorCodes;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] getNetworkErrorCodes not available');
  }
  return fn();
}
