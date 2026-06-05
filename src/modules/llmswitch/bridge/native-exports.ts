/**
 * Native Binding Exports Bridge
 *
 * Thin wrappers around llmswitch-core native bindings.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { importCoreDist, requireCoreDist, resolveCoreModulePath, type AnyRecord } from './module-loader.js';
import type { ToolExecutionFailureSignal } from './snapshot-recorder-types.js';

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
  isEmptyClientResponsePayloadJson?: (bodyJson: string) => boolean;
  classifyEmptyResponseSignalJson?: (stage: string, bodyJson: string) => string;
  detectToolExecutionFailuresJson?: (bodyJson: string) => string;
  updateResponsesContractProbeFromSseChunkJson?: (chunkJson: string, probeJson: string) => string;
  buildResponsesTerminalSseFramesFromProbeJson?: (probeJson: string, requestLabel: string) => string;
  resolveProviderResponseRequestSemanticsJson?: (
    processedJson: string,
    standardizedJson: string,
    requestMetadataJson: string
  ) => string;
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
  validateResponsesDirectToolShapeContractWithNative?: (
    payload: Record<string, unknown>
  ) => { ok: true } | null;
  applyResponsesDirectRouteParamsOverrideWithNative?: (input: {
    payload: Record<string, unknown>;
    routeParams?: Record<string, unknown>;
    providerDefaultModel?: string;
    requestReasoningEffort?: string;
  }) => Record<string, unknown>;
  buildResponsesDirectPassthroughBodyWithNative?: (
    payload: unknown
  ) => Record<string, unknown>;
  hasDeclaredApplyPatchToolWithNative?: (
    payload: unknown
  ) => boolean;
  evaluateResponsesDirectRouteDecisionWithNative?: (input: {
    payload: Record<string, unknown>;
    inboundProtocol: string;
    applyPatchMode?: string;
  }) => {
    providerWireValid: boolean;
    requiresHubRelay: boolean;
    reason?: string;
    hasDeclaredApplyPatchTool?: boolean;
  };
  resolveResponsesDirectPayloadWithNative?: (input: {
    body: unknown;
    rawRequestBody?: Record<string, unknown>;
    bodyStream?: boolean;
    metadataStream?: boolean;
    outboundStream?: boolean;
  }) => Record<string, unknown>;
};

type NativeHubVrNodeContracts = {
  describeHubPipelineContractsWithNative?: () => AnyRecord;
  describeVirtualRouterContractsWithNative?: () => AnyRecord;
  describeMetaCarrierContractsWithNative?: () => AnyRecord;
  describePipelineContractWithNative?: (nodeId: string) => AnyRecord;
  validatePipelineNodeContractBoundaryWithNative?: (
    nodeId: string,
    before: unknown,
    after: unknown
  ) => AnyRecord;
};

let cachedSharedSemantics: NativeSharedConversionSemantics | null | undefined;
let cachedRespSemantics: NativeHubPipelineRespSemantics | null | undefined;
let cachedFollowupSanitize: FollowupSanitizeModule | null | undefined;
let cachedFailurePolicyModule: NativeFailurePolicyModule | null | undefined;
let cachedHubBridgePolicySemantics: NativeHubBridgePolicySemantics | null | undefined;
let cachedHubBridgePolicySemanticsSync: NativeHubBridgePolicySemantics | null | undefined;
let cachedHubVrNodeContracts: NativeHubVrNodeContracts | null | undefined;
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

function getHubVrNodeContracts(): NativeHubVrNodeContracts {
  if (cachedHubVrNodeContracts !== undefined) {
    if (!cachedHubVrNodeContracts) {
      throw new Error('[llmswitch-bridge] native-hub-vr-node-contracts not available');
    }
    return cachedHubVrNodeContracts;
  }
  try {
    cachedHubVrNodeContracts = requireCoreDist<NativeHubVrNodeContracts>(
      'router/virtual-router/engine-selection/native-hub-vr-node-contracts'
    );
  } catch {
    cachedHubVrNodeContracts = null;
  }
  if (!cachedHubVrNodeContracts) {
    throw new Error('[llmswitch-bridge] native-hub-vr-node-contracts not available');
  }
  return cachedHubVrNodeContracts;
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

function getHubBridgePolicySemanticsSync(): NativeHubBridgePolicySemantics {
  if (cachedHubBridgePolicySemanticsSync !== undefined) {
    if (!cachedHubBridgePolicySemanticsSync) {
      throw new Error('[llmswitch-bridge] native-hub-bridge-policy-semantics not available');
    }
    return cachedHubBridgePolicySemanticsSync;
  }
  try {
    cachedHubBridgePolicySemanticsSync = requireCoreDist<NativeHubBridgePolicySemantics>(
      'router/virtual-router/engine-selection/native-hub-bridge-policy-semantics'
    );
  } catch {
    cachedHubBridgePolicySemanticsSync = null;
  }
  if (!cachedHubBridgePolicySemanticsSync) {
    throw new Error('[llmswitch-bridge] native-hub-bridge-policy-semantics not available');
  }
  return cachedHubBridgePolicySemanticsSync;
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

export function validateResponsesDirectToolShapeContractNative(
  payload: Record<string, unknown>
): { ok: true } | null {
  let mod: NativeHubBridgePolicySemantics;
  try {
    mod = getHubBridgePolicySemanticsSync();
  } catch {
    return null;
  }
  const fn = mod.validateResponsesDirectToolShapeContractWithNative;
  if (typeof fn !== 'function') {
    return null;
  }
  return fn(payload) as { ok: true } | null;
}

export function applyResponsesDirectRouteParamsOverrideNative(input: {
  payload: Record<string, unknown>;
  routeParams?: Record<string, unknown>;
  providerDefaultModel?: string;
  requestReasoningEffort?: string;
}): AnyRecord {
  const mod = getHubBridgePolicySemanticsSync();
  const fn = mod.applyResponsesDirectRouteParamsOverrideWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] applyResponsesDirectRouteParamsOverrideWithNative not available');
  }
  return fn(input) as AnyRecord;
}

export function buildResponsesDirectPassthroughBodyNative(payload: unknown): AnyRecord {
  const mod = getHubBridgePolicySemanticsSync();
  const fn = mod.buildResponsesDirectPassthroughBodyWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] buildResponsesDirectPassthroughBodyWithNative not available');
  }
  return fn(payload) as AnyRecord;
}

export function hasDeclaredApplyPatchToolNative(payload: unknown): boolean {
  const mod = getHubBridgePolicySemanticsSync();
  const fn = mod.hasDeclaredApplyPatchToolWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] hasDeclaredApplyPatchToolWithNative not available');
  }
  return fn(payload) === true;
}

export function evaluateResponsesDirectRouteDecisionNative(input: {
  payload: Record<string, unknown>;
  inboundProtocol: string;
  applyPatchMode?: string;
}): {
  providerWireValid: boolean;
  requiresHubRelay: boolean;
  reason?: string;
  hasDeclaredApplyPatchTool?: boolean;
} {
  const mod = getHubBridgePolicySemanticsSync();
  const fn = mod.evaluateResponsesDirectRouteDecisionWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] evaluateResponsesDirectRouteDecisionWithNative not available');
  }
  return fn(input);
}

export function resolveResponsesDirectPayloadNative(input: {
  body: unknown;
  rawRequestBody?: Record<string, unknown>;
  bodyStream?: boolean;
  metadataStream?: boolean;
  outboundStream?: boolean;
}): AnyRecord {
  const mod = getHubBridgePolicySemanticsSync();
  const fn = mod.resolveResponsesDirectPayloadWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resolveResponsesDirectPayloadWithNative not available');
  }
  return fn(input) as AnyRecord;
}

export function describeHubPipelineContractsNative(): AnyRecord {
  const fn = getHubVrNodeContracts().describeHubPipelineContractsWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] describeHubPipelineContractsWithNative not available');
  }
  return fn();
}

export function describeVirtualRouterContractsNative(): AnyRecord {
  const fn = getHubVrNodeContracts().describeVirtualRouterContractsWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] describeVirtualRouterContractsWithNative not available');
  }
  return fn();
}

export function describeMetaCarrierContractsNative(): AnyRecord {
  const fn = getHubVrNodeContracts().describeMetaCarrierContractsWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] describeMetaCarrierContractsWithNative not available');
  }
  return fn();
}

export function describePipelineContractNative(nodeId: string): AnyRecord {
  const fn = getHubVrNodeContracts().describePipelineContractWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] describePipelineContractWithNative not available');
  }
  return fn(nodeId);
}

export function validatePipelineNodeContractBoundaryNative(
  nodeId: string,
  before: unknown,
  after: unknown
): AnyRecord {
  const fn = getHubVrNodeContracts().validatePipelineNodeContractBoundaryWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] validatePipelineNodeContractBoundaryWithNative not available');
  }
  return fn(nodeId, before, after);
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

export function isEmptyClientResponsePayloadNative(body: unknown): boolean {
  const fn = getChatProcessNodeResultSemantics().isEmptyClientResponsePayloadJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] isEmptyClientResponsePayloadJson not available');
  }
  return Boolean(fn(JSON.stringify(body ?? null)));
}

export function classifyEmptyResponseSignalNative(
  stage: string,
  body: unknown
): { errorType: string; matchedText: string; responseSummary: Record<string, unknown> } | null {
  const fn = getChatProcessNodeResultSemantics().classifyEmptyResponseSignalJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] classifyEmptyResponseSignalJson not available');
  }
  const raw = fn(String(stage || ''), JSON.stringify(body ?? null));
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[llmswitch-bridge] classifyEmptyResponseSignalJson returned invalid payload');
  }
  return parsed as { errorType: string; matchedText: string; responseSummary: Record<string, unknown> };
}

export function detectToolExecutionFailuresNative(body: unknown): ToolExecutionFailureSignal[] {
  const fn = getChatProcessNodeResultSemantics().detectToolExecutionFailuresJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] detectToolExecutionFailuresJson not available');
  }
  const raw = fn(JSON.stringify(body ?? null));
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('[llmswitch-bridge] detectToolExecutionFailuresJson returned invalid payload');
  }
  return parsed as ToolExecutionFailureSignal[];
}

export function resolveProviderResponseRequestSemanticsNative(
  processed: Record<string, unknown> | undefined,
  standardized: Record<string, unknown> | undefined,
  requestMetadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const fn = getChatProcessNodeResultSemantics().resolveProviderResponseRequestSemanticsJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resolveProviderResponseRequestSemanticsJson not available');
  }
  const raw = fn(
    JSON.stringify(processed ?? null),
    JSON.stringify(standardized ?? null),
    JSON.stringify(requestMetadata ?? null)
  );
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null) {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[llmswitch-bridge] resolveProviderResponseRequestSemanticsJson returned invalid payload');
  }
  return parsed as Record<string, unknown>;
}

export function updateResponsesContractProbeFromSseChunkNative(
  chunk: unknown,
  probe: Record<string, unknown> | undefined
): Record<string, unknown> {
  const fn = getChatProcessNodeResultSemantics().updateResponsesContractProbeFromSseChunkJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] updateResponsesContractProbeFromSseChunkJson not available');
  }
  const raw = fn(JSON.stringify(typeof chunk === 'string' ? chunk : String(chunk ?? '')), JSON.stringify(probe ?? {}));
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[llmswitch-bridge] updateResponsesContractProbeFromSseChunkJson returned invalid payload');
  }
  return parsed as Record<string, unknown>;
}

export function buildResponsesTerminalSseFramesFromProbeNative(
  probe: Record<string, unknown> | undefined,
  requestLabel: string
): string[] {
  const fn = getChatProcessNodeResultSemantics().buildResponsesTerminalSseFramesFromProbeJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] buildResponsesTerminalSseFramesFromProbeJson not available');
  }
  const raw = fn(JSON.stringify(probe ?? {}), String(requestLabel || 'unknown'));
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((frame) => typeof frame === 'string')) {
    throw new Error('[llmswitch-bridge] buildResponsesTerminalSseFramesFromProbeJson returned invalid payload');
  }
  return parsed as string[];
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
