/**
 * Native Binding Exports Bridge
 *
 * Thin wrappers around llmswitch-core native bindings.
 */

import { importCoreDist, type AnyRecord } from './module-loader.js';
import {
  classifyProviderFailure as classifyProviderFailureFromCore,
  computeBackoffMsNative as computeBackoffMsNativeFromCore,
  getNetworkErrorCodes as getNetworkErrorCodesFromCore,
  isBlockingRecoverableNative as isBlockingRecoverableNativeFromCore,
  shouldRetryNative as shouldRetryNativeFromCore
} from '../../../../node_modules/rcc-llmswitch-core/dist/router/virtual-router/engine-selection/native-failure-policy.js';

type NativeFailureClassification = Parameters<typeof isBlockingRecoverableNativeFromCore>[0];

type NativeSharedConversionSemantics = {
  mapChatToolsToBridgeWithNative?: (rawTools: unknown) => Array<Record<string, unknown>>;
  injectMcpToolsForChatWithNative?: (tools: unknown[] | undefined, discoveredServers: string[]) => unknown[];
  injectMcpToolsForResponsesWithNative?: (tools: unknown[] | undefined, discoveredServers: string[]) => unknown[];
  normalizeAssistantTextToToolCallsWithNative?: (
    message: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Record<string, unknown>;
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

let cachedSharedSemantics: NativeSharedConversionSemantics | null | undefined;
let cachedRespSemantics: NativeHubPipelineRespSemantics | null | undefined;
let cachedFollowupSanitize: FollowupSanitizeModule | null | undefined;
let sharedBindingsChecked: boolean | undefined;
let respBindingsChecked: boolean | undefined;

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

export function classifyProviderFailure(
  statusCode: number | undefined,
  errorCode: string | undefined,
  upstreamCode: string | undefined,
  isNetworkError: boolean,
): string {
  return classifyProviderFailureFromCore(statusCode, errorCode, upstreamCode, isNetworkError);
}

export function isBlockingRecoverableNative(
  classification: NativeFailureClassification,
  stage: string | undefined
): boolean {
  return isBlockingRecoverableNativeFromCore(classification, stage);
}

export function shouldRetryNative(
  classification: NativeFailureClassification,
  attempt: number,
  maxAttempts: number
): boolean {
  return shouldRetryNativeFromCore(classification, attempt, maxAttempts);
}

export function computeBackoffMsNative(
  classification: NativeFailureClassification,
  attempt: number,
  baseMs: number,
  maxMs: number
): number {
  return computeBackoffMsNativeFromCore(classification, attempt, baseMs, maxMs);
}

export function getNetworkErrorCodes(): string[] {
  return getNetworkErrorCodesFromCore();
}
