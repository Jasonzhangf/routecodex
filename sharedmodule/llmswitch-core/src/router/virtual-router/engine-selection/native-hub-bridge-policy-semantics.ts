import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export interface NativeBridgeActionDescriptor {
  name: string;
  options?: Record<string, unknown>;
}

export interface NativeBridgePhaseConfig {
  inbound?: NativeBridgeActionDescriptor[];
  outbound?: NativeBridgeActionDescriptor[];
}

export interface NativeBridgePolicy {
  id: string;
  protocol?: string;
  moduleType?: string;
  request?: NativeBridgePhaseConfig;
  response?: NativeBridgePhaseConfig;
}

type NativeBridgePolicyStage =
  | 'request_inbound'
  | 'request_outbound'
  | 'response_inbound'
  | 'response_outbound';

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function invokeNativeStringCapability(capability: string, args: unknown[]): string {
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(...args);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return raw;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

function invokeNativeStringCapabilityWithJsonArgs(capability: string, args: unknown[]): string {
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  const encodedArgs: string[] = [];
  for (const arg of args) {
    const encoded = safeStringify(arg);
    if (!encoded) {
      return fail('json stringify failed');
    }
    encodedArgs.push(encoded);
  }
  return invokeNativeStringCapability(capability, encodedArgs);
}

function parseActionDescriptor(candidate: unknown): NativeBridgeActionDescriptor | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }
  const row = candidate as Record<string, unknown>;
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (!name) {
    return null;
  }
  const options = row.options;
  return {
    name,
    ...(options && typeof options === 'object' && !Array.isArray(options)
      ? { options: options as Record<string, unknown> }
      : {})
  };
}

function parseActionDescriptors(raw: string): NativeBridgeActionDescriptor[] | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed == null) {
      return undefined;
    }
    if (!Array.isArray(parsed)) {
      return null;
    }
    const out = parsed
      .map((entry) => parseActionDescriptor(entry))
      .filter((entry): entry is NativeBridgeActionDescriptor => Boolean(entry));
    return out;
  } catch {
    return null;
  }
}

function parsePhase(candidate: unknown): NativeBridgePhaseConfig | undefined | null {
  if (candidate == null) {
    return undefined;
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }
  const row = candidate as Record<string, unknown>;
  const out: NativeBridgePhaseConfig = {};
  if (Object.prototype.hasOwnProperty.call(row, 'inbound')) {
    if (row.inbound == null) {
      out.inbound = undefined;
    } else if (Array.isArray(row.inbound)) {
      const inbound = row.inbound
        .map((entry) => parseActionDescriptor(entry))
        .filter((entry): entry is NativeBridgeActionDescriptor => Boolean(entry));
      out.inbound = inbound;
    } else {
      return null;
    }
  }
  if (Object.prototype.hasOwnProperty.call(row, 'outbound')) {
    if (row.outbound == null) {
      out.outbound = undefined;
    } else if (Array.isArray(row.outbound)) {
      const outbound = row.outbound
        .map((entry) => parseActionDescriptor(entry))
        .filter((entry): entry is NativeBridgeActionDescriptor => Boolean(entry));
      out.outbound = outbound;
    } else {
      return null;
    }
  }
  return out;
}

function parsePolicy(raw: string): NativeBridgePolicy | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed == null) {
      return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id) {
      return null;
    }
    const protocol = typeof row.protocol === 'string' && row.protocol.trim().length
      ? row.protocol.trim()
      : undefined;
    const moduleType = typeof row.moduleType === 'string' && row.moduleType.trim().length
      ? row.moduleType.trim()
      : undefined;
    const request = parsePhase(row.request);
    if (request === null) {
      return null;
    }
    const response = parsePhase(row.response);
    if (response === null) {
      return null;
    }
    return {
      id,
      ...(protocol ? { protocol } : {}),
      ...(moduleType ? { moduleType } : {}),
      ...(request ? { request } : {}),
      ...(response ? { response } : {})
    };
  } catch {
    return null;
  }
}

export function resolveBridgePolicyWithNative(options: {
  protocol?: string;
  moduleType?: string;
} | undefined): NativeBridgePolicy | undefined {
  const capability = 'resolveBridgePolicyJson';
  const fail = (reason?: string) => failNativeRequired<NativeBridgePolicy | undefined>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [{
    protocol: options?.protocol,
    moduleType: options?.moduleType
  }]);
    const parsed = parsePolicy(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveBridgePolicyActionsWithNative(
  policy: NativeBridgePolicy | undefined,
  stage: NativeBridgePolicyStage
): NativeBridgeActionDescriptor[] | undefined {
  const capability = 'resolveBridgePolicyActionsJson';
  const fail = (reason?: string) =>
    failNativeRequired<NativeBridgeActionDescriptor[] | undefined>(capability, reason);
  try {
    const policyJson = safeStringify(policy ?? null);
    if (!policyJson) {
      return fail('json stringify failed');
    }
    const raw = invokeNativeStringCapability(capability, [policyJson, String(stage || '')]);
    const parsed = parseActionDescriptors(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export interface NativeProviderOutboundLayoutRule {
  code: 'forbid_wrapper';
  path: string;
  detail: string;
}

export interface NativeProviderOutboundWrapperFlattenRule {
  wrapperKey: string;
  allowKeys?: string[];
  aliasKeys?: Record<string, string>;
  onlyIfTargetMissing?: boolean;
}

export interface NativeProviderOutboundPolicySpec {
  enforceEnabled: boolean;
  allowedTopLevelKeys?: string[];
  enforceAllowedTopLevelKeys?: boolean;
  reservedKeyPrefixes: string[];
  forbidWrappers: NativeProviderOutboundLayoutRule[];
  flattenWrappers: NativeProviderOutboundWrapperFlattenRule[];
}

export interface NativeToolSurfaceSpec {
  expectedToolFormat: 'openai' | 'anthropic' | 'gemini';
  expectedHistoryCarrier?: 'messages' | 'input';
}

export interface NativeProtocolSpec {
  id: 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';
  providerOutbound: NativeProviderOutboundPolicySpec;
  toolSurface: NativeToolSurfaceSpec;
}

export interface NativeHubProtocolAllowlists {
  openaiChatAllowedFields: string[];
  openaiChatParametersWrapperAllowKeys: string[];
  openaiResponsesAllowedFields: string[];
  openaiResponsesParametersWrapperAllowKeys: string[];
  anthropicAllowedFields: string[];
  anthropicParametersWrapperAllowKeys: string[];
  geminiAllowedFields: string[];
}

function parseLayoutRule(candidate: unknown): NativeProviderOutboundLayoutRule | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }
  const row = candidate as Record<string, unknown>;
  const code = typeof row.code === 'string' ? row.code.trim() : '';
  const path = typeof row.path === 'string' ? row.path.trim() : '';
  const detail = typeof row.detail === 'string' ? row.detail : '';
  if (code !== 'forbid_wrapper' || !path || !detail) {
    return null;
  }
  return { code: 'forbid_wrapper', path, detail };
}

function parseFlattenRule(candidate: unknown): NativeProviderOutboundWrapperFlattenRule | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }
  const row = candidate as Record<string, unknown>;
  const wrapperKey = typeof row.wrapperKey === 'string' ? row.wrapperKey.trim() : '';
  if (!wrapperKey) {
    return null;
  }
  const allowKeys = Array.isArray(row.allowKeys)
    ? row.allowKeys.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const aliasKeys =
    row.aliasKeys && typeof row.aliasKeys === 'object' && !Array.isArray(row.aliasKeys)
      ? Object.fromEntries(
          Object.entries(row.aliasKeys as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        )
      : undefined;
  const onlyIfTargetMissing =
    typeof row.onlyIfTargetMissing === 'boolean' ? row.onlyIfTargetMissing : undefined;
  return {
    wrapperKey,
    ...(allowKeys ? { allowKeys } : {}),
    ...(aliasKeys ? { aliasKeys } : {}),
    ...(typeof onlyIfTargetMissing === 'boolean' ? { onlyIfTargetMissing } : {})
  };
}

function parseProtocolSpec(raw: string): NativeProtocolSpec | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const id = row.id;
    if (
      id !== 'openai-chat' &&
      id !== 'openai-responses' &&
      id !== 'anthropic-messages' &&
      id !== 'gemini-chat'
    ) {
      return null;
    }
    const providerOutbound =
      row.providerOutbound && typeof row.providerOutbound === 'object' && !Array.isArray(row.providerOutbound)
        ? (row.providerOutbound as Record<string, unknown>)
        : null;
    if (!providerOutbound) {
      return null;
    }
    const enforceEnabled = providerOutbound.enforceEnabled;
    if (typeof enforceEnabled !== 'boolean') {
      return null;
    }
    const allowedTopLevelKeys = Array.isArray(providerOutbound.allowedTopLevelKeys)
      ? providerOutbound.allowedTopLevelKeys.filter((entry): entry is string => typeof entry === 'string')
      : undefined;
    const enforceAllowedTopLevelKeys =
      typeof providerOutbound.enforceAllowedTopLevelKeys === 'boolean'
        ? providerOutbound.enforceAllowedTopLevelKeys
        : undefined;
    const reservedKeyPrefixes = Array.isArray(providerOutbound.reservedKeyPrefixes)
      ? providerOutbound.reservedKeyPrefixes.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const forbidWrappers = Array.isArray(providerOutbound.forbidWrappers)
      ? providerOutbound.forbidWrappers
          .map((entry) => parseLayoutRule(entry))
          .filter((entry): entry is NativeProviderOutboundLayoutRule => Boolean(entry))
      : [];
    const flattenWrappers = Array.isArray(providerOutbound.flattenWrappers)
      ? providerOutbound.flattenWrappers
          .map((entry) => parseFlattenRule(entry))
          .filter((entry): entry is NativeProviderOutboundWrapperFlattenRule => Boolean(entry))
      : [];
    const toolSurface =
      row.toolSurface && typeof row.toolSurface === 'object' && !Array.isArray(row.toolSurface)
        ? (row.toolSurface as Record<string, unknown>)
        : null;
    if (!toolSurface) {
      return null;
    }
    const expectedToolFormat = toolSurface.expectedToolFormat;
    if (
      expectedToolFormat !== 'openai' &&
      expectedToolFormat !== 'anthropic' &&
      expectedToolFormat !== 'gemini'
    ) {
      return null;
    }
    const expectedHistoryCarrier =
      toolSurface.expectedHistoryCarrier === 'messages' || toolSurface.expectedHistoryCarrier === 'input'
        ? toolSurface.expectedHistoryCarrier
        : undefined;
    return {
      id,
      providerOutbound: {
        enforceEnabled,
        ...(allowedTopLevelKeys ? { allowedTopLevelKeys } : {}),
        ...(typeof enforceAllowedTopLevelKeys === 'boolean' ? { enforceAllowedTopLevelKeys } : {}),
        reservedKeyPrefixes,
        forbidWrappers,
        flattenWrappers
      },
      toolSurface: {
        expectedToolFormat,
        ...(expectedHistoryCarrier ? { expectedHistoryCarrier } : {})
      }
    };
  } catch {
    return null;
  }
}

function parseStringArrayValue(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out = value.filter((entry): entry is string => typeof entry === 'string');
  return out;
}

function parseHubProtocolAllowlists(raw: string): NativeHubProtocolAllowlists | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const openaiChatAllowedFields = parseStringArrayValue(row.openaiChatAllowedFields);
    const openaiChatParametersWrapperAllowKeys = parseStringArrayValue(row.openaiChatParametersWrapperAllowKeys);
    const openaiResponsesAllowedFields = parseStringArrayValue(row.openaiResponsesAllowedFields);
    const openaiResponsesParametersWrapperAllowKeys = parseStringArrayValue(row.openaiResponsesParametersWrapperAllowKeys);
    const anthropicAllowedFields = parseStringArrayValue(row.anthropicAllowedFields);
    const anthropicParametersWrapperAllowKeys = parseStringArrayValue(row.anthropicParametersWrapperAllowKeys);
    const geminiAllowedFields = parseStringArrayValue(row.geminiAllowedFields);
    if (
      !openaiChatAllowedFields ||
      !openaiChatParametersWrapperAllowKeys ||
      !openaiResponsesAllowedFields ||
      !openaiResponsesParametersWrapperAllowKeys ||
      !anthropicAllowedFields ||
      !anthropicParametersWrapperAllowKeys ||
      !geminiAllowedFields
    ) {
      return null;
    }
    return {
      openaiChatAllowedFields,
      openaiChatParametersWrapperAllowKeys,
      openaiResponsesAllowedFields,
      openaiResponsesParametersWrapperAllowKeys,
      anthropicAllowedFields,
      anthropicParametersWrapperAllowKeys,
      geminiAllowedFields
    };
  } catch {
    return null;
  }
}

export function resolveHubProtocolSpecWithNative(input: {
  protocol?: string;
  allowlists: {
    openaiChatAllowedFields: readonly string[];
    openaiChatParametersWrapperAllowKeys: readonly string[];
    openaiResponsesAllowedFields: readonly string[];
    openaiResponsesParametersWrapperAllowKeys: readonly string[];
    anthropicAllowedFields: readonly string[];
    anthropicParametersWrapperAllowKeys: readonly string[];
    geminiAllowedFields: readonly string[];
  };
}): NativeProtocolSpec {
  const capability = 'resolveHubProtocolSpecJson';
  const fail = (reason?: string) => failNativeRequired<NativeProtocolSpec>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [{
    protocol: input?.protocol,
    allowlists: {
      openaiChatAllowedFields: input?.allowlists?.openaiChatAllowedFields ?? [],
      openaiChatParametersWrapperAllowKeys: input?.allowlists?.openaiChatParametersWrapperAllowKeys ?? [],
      openaiResponsesAllowedFields: input?.allowlists?.openaiResponsesAllowedFields ?? [],
      openaiResponsesParametersWrapperAllowKeys: input?.allowlists?.openaiResponsesParametersWrapperAllowKeys ?? [],
      anthropicAllowedFields: input?.allowlists?.anthropicAllowedFields ?? [],
      anthropicParametersWrapperAllowKeys: input?.allowlists?.anthropicParametersWrapperAllowKeys ?? [],
      geminiAllowedFields: input?.allowlists?.geminiAllowedFields ?? []
    }
  }]);
    const parsed = parseProtocolSpec(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveHubProtocolAllowlistsWithNative(): NativeHubProtocolAllowlists {
  const capability = 'resolveHubProtocolAllowlistsJson';
  const fail = (reason?: string) => failNativeRequired<NativeHubProtocolAllowlists>(capability, reason);
  try {
    const raw = invokeNativeStringCapability(capability, []);
    const parsed = parseHubProtocolAllowlists(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
