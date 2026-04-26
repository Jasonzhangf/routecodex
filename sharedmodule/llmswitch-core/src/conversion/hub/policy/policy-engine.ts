import type { JsonObject } from '../types/json.js';
import type { StageRecorder } from '../format-adapters/index.js';
import { resolveHubProtocolSpec } from './protocol-spec.js';
import { normalizeProviderProtocolTokenWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';
import { loadCompatProfileRegistry, getPolicyOverrides } from '../../compat/profile-registry/registry.js';
import { shouldSkipPolicy } from '../../compat/profile-registry/policy-overrides.js';

// Load compat registry at module level for config-driven policy overrides
const policyCompatRegistry = loadCompatProfileRegistry();

export type HubPolicyMode = 'off' | 'observe' | 'enforce';

export interface HubPolicyConfig {
  mode?: HubPolicyMode;
  /**
   * Optional: sampling rate in [0, 1]. When provided, observation is best-effort
   * and may skip recording for some requests.
   */
  sampleRate?: number;
}

export interface PolicyObservation {
  phase: 'client_inbound' | 'provider_outbound' | 'provider_inbound' | 'client_outbound';
  providerProtocol: string;
  violations: Array<{
    code: 'unexpected_wrapper' | 'unexpected_field';
    path: string;
    detail?: string;
  }>;
  summary: {
    totalViolations: number;
    unexpectedFieldCount: number;
  };
}

export interface ProviderOutboundPolicyApplyResult {
  payload: JsonObject;
  changed: boolean;
  removedTopLevelKeys: string[];
  flattenedWrappers: string[];
}

let hubPolicyRuntime: HubPolicyConfig | undefined = undefined;

export function setHubPolicyRuntimePolicy(policy?: HubPolicyConfig): void {
  hubPolicyRuntime = policy;
}

function resolveEffectivePolicy(policy?: HubPolicyConfig): HubPolicyConfig | undefined {
  return policy ?? hubPolicyRuntime;
}

function shouldSample(rate: number | undefined): boolean {
  if (rate === undefined) return true;
  if (!Number.isFinite(rate)) return true;
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return Math.random() < rate;
}

function isJsonRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasGeminiCliRequestWrapper(payload: JsonObject): boolean {
  const request = (payload as Record<string, unknown>).request;
  if (!isJsonRecord(request)) {
    return false;
  }
  const req = request as Record<string, unknown>;
  return (
    Object.prototype.hasOwnProperty.call(req, 'contents') ||
    Object.prototype.hasOwnProperty.call(req, 'systemInstruction') ||
    Object.prototype.hasOwnProperty.call(req, 'tools') ||
    Object.prototype.hasOwnProperty.call(req, 'toolConfig') ||
    Object.prototype.hasOwnProperty.call(req, 'generationConfig') ||
    Object.prototype.hasOwnProperty.call(req, 'safetySettings')
  );
}

function isGeminiCliPayload(payload: JsonObject): boolean {
  const record = payload as Record<string, unknown>;
  return (
    typeof record.project === 'string' ||
    typeof record.requestType === 'string' ||
    typeof record.userAgent === 'string' ||
    typeof record.requestId === 'string' ||
    hasGeminiCliRequestWrapper(payload)
  );
}

function normalizeHubProviderProtocol(providerProtocol: string): string {
  return normalizeProviderProtocolTokenWithNative(providerProtocol) ?? providerProtocol;
}

function extendGeminiAllowlistIfNeeded(
  providerProtocol: string,
  payload: JsonObject,
  allowedTopLevelKeys?: Set<string>
): Set<string> | undefined {
  if (providerProtocol !== 'gemini-chat') {
    return allowedTopLevelKeys;
  }
  if (!isGeminiCliPayload(payload)) {
    return allowedTopLevelKeys;
  }
  const extended = allowedTopLevelKeys ? new Set(allowedTopLevelKeys) : new Set<string>();
  extended.add('request');
  extended.add('project');
  extended.add('requestId');
  extended.add('requestType');
  extended.add('userAgent');
  extended.add('action');
  return extended;
}

function applyProviderOutboundPolicy(providerProtocol: string, payload: JsonObject): ProviderOutboundPolicyApplyResult {
  const removedTopLevelKeys: string[] = [];
  const flattenedWrappers: string[] = [];

  const spec = resolveHubProtocolSpec(providerProtocol);
  if (!spec.providerOutbound.enforceEnabled) {
    return {
      payload,
      changed: false,
      removedTopLevelKeys,
      flattenedWrappers
    };
  }
  let out: JsonObject = payload;
  const ensureOutClone = () => {
    if (out === payload) {
      out = { ...(payload as Record<string, unknown>) } as JsonObject;
    }
  };

  const allowedTopLevelKeys =
    Array.isArray(spec.providerOutbound.allowedTopLevelKeys) &&
    spec.providerOutbound.allowedTopLevelKeys.length > 0 &&
    spec.providerOutbound.enforceAllowedTopLevelKeys === true
      ? new Set(spec.providerOutbound.allowedTopLevelKeys)
      : undefined;
  const isGeminiCli = providerProtocol === 'gemini-chat' && isGeminiCliPayload(payload);
  const allowedTopLevelKeysResolved = extendGeminiAllowlistIfNeeded(providerProtocol, payload, allowedTopLevelKeys);

  // Reserved/private keys must never be sent upstream.
  for (const key of Object.keys(payload)) {
    if (spec.providerOutbound.reservedKeyPrefixes.some((prefix) => key.startsWith(prefix))) {
      ensureOutClone();
      delete (out as any)[key];
      removedTopLevelKeys.push(key);
    }
  }

  // Flatten accidental wrappers that have caused upstream 400s.
  for (const rule of spec.providerOutbound.flattenWrappers) {
    const wrapperKey = rule.wrapperKey;
    if (!wrapperKey || typeof wrapperKey !== 'string') {
      continue;
    }
    if (isGeminiCli && wrapperKey === 'request') {
      continue;
    }
    if (!isJsonRecord((out as any)[wrapperKey])) {
      continue;
    }

    ensureOutClone();
    const inner = { ...((out as any)[wrapperKey] as Record<string, unknown>) };
    const alias = rule.aliasKeys || {};
    for (const [from, to] of Object.entries(alias)) {
      if (inner[to] === undefined && inner[from] !== undefined) {
        inner[to] = inner[from];
      }
    }

    const allow = Array.isArray(rule.allowKeys) ? new Set(rule.allowKeys) : null;
    const onlyIfMissing = rule.onlyIfTargetMissing !== false;
    for (const [key, value] of Object.entries(inner)) {
      if (allow && !allow.has(key)) {
        continue;
      }
      if (!onlyIfMissing || (out as any)[key] === undefined) {
        (out as any)[key] = value;
      }
    }
    delete (out as any)[wrapperKey];
    flattenedWrappers.push(wrapperKey);
  }

  // Enforce protocol allowlist (top-level). Only runs when explicitly enabled
  // for this protocol, and only after wrapper flatten so allowed fields are
  // present at the correct level.
  if (allowedTopLevelKeysResolved) {
    for (const key of Object.keys(out)) {
      if (allowedTopLevelKeysResolved.has(key)) continue;
      ensureOutClone();
      delete (out as any)[key];
      removedTopLevelKeys.push(key);
    }
  }

  return {
    payload: out,
    changed: out !== payload || removedTopLevelKeys.length > 0 || flattenedWrappers.length > 0,
    removedTopLevelKeys,
    flattenedWrappers
  };
}

function observeProviderPayload(options: {
  phase: PolicyObservation['phase'];
  providerProtocol: string;
  payload: JsonObject;
}): PolicyObservation {
  const violations: PolicyObservation['violations'] = [];

  // Observe-only: detect known layout anti-patterns and reserved keys.
  // Do NOT modify payload here.
  const spec = resolveHubProtocolSpec(options.providerProtocol);
  const allowlistEnabled = options.phase === 'provider_outbound';
  const isGeminiCli = options.providerProtocol === 'gemini-chat' && isGeminiCliPayload(options.payload);
  const allowedTopLevelKeys =
    allowlistEnabled && Array.isArray(spec.providerOutbound.allowedTopLevelKeys)
      ? new Set(spec.providerOutbound.allowedTopLevelKeys)
      : undefined;
  const allowedTopLevelKeysResolved = extendGeminiAllowlistIfNeeded(
    options.providerProtocol,
    options.payload,
    allowedTopLevelKeys
  );
  for (const rule of spec.providerOutbound.forbidWrappers) {
    if (rule.code !== 'forbid_wrapper') {
      continue;
    }
    if (isGeminiCli && rule.path === 'request') {
      continue;
    }
    if (rule.path in options.payload && isJsonRecord((options.payload as any)[rule.path])) {
      violations.push({
        code: 'unexpected_wrapper',
        path: rule.path,
        detail: rule.detail
      });
    }
  }

  // Always record unknown private wrapper keys (best-effort, conservative).
  for (const key of Object.keys(options.payload)) {
    if (spec.providerOutbound.reservedKeyPrefixes.some((prefix) => key.startsWith(prefix))) {
      violations.push({
        code: 'unexpected_field',
        path: key
      });
      continue;
    }
    if (allowedTopLevelKeysResolved && !allowedTopLevelKeysResolved.has(key)) {
      violations.push({
        code: 'unexpected_field',
        path: key,
        detail: `Top-level key is not in protocol allowlist: ${options.providerProtocol}`
      });
    }
  }

  const unexpectedFieldCount = violations.filter((v) => v.code === 'unexpected_field').length;
  return {
    phase: options.phase,
    providerProtocol: options.providerProtocol,
    violations,
    summary: {
      totalViolations: violations.length,
      unexpectedFieldCount
    }
  };
}

export function recordHubPolicyObservation(options: {
  policy?: HubPolicyConfig;
  phase?: PolicyObservation['phase'];
  providerProtocol: string;
  compatibilityProfile?: string;
  payload: JsonObject;
  stageRecorder?: StageRecorder;
  requestId?: string;
}): void {
  if (!options.stageRecorder) {
    return;
  }
  const effectivePolicy = resolveEffectivePolicy(options.policy);
  const mode = effectivePolicy?.mode ?? 'off';
  // Keep observing in enforce mode (best-effort) so operators can monitor
  // violations while gradually turning enforcement on.
  if (mode !== 'observe' && mode !== 'enforce') {
    return;
  }

  const compatibilityProfile =
    typeof options.compatibilityProfile === 'string' ? options.compatibilityProfile.trim().toLowerCase() : '';
  if (compatibilityProfile) {
    const overrides = getPolicyOverrides(policyCompatRegistry, compatibilityProfile);
    if (shouldSkipPolicy(overrides, 'observe')) {
      return;
    }
  }

  if (!shouldSample(effectivePolicy?.sampleRate)) {
    return;
  }

  const normalizedProviderProtocol = normalizeHubProviderProtocol(options.providerProtocol);

  try {
    const phase = options.phase ?? 'provider_outbound';
    const observation = observeProviderPayload({
      phase,
      providerProtocol: normalizedProviderProtocol,
      payload: options.payload
    });
    if (observation.summary.totalViolations <= 0) {
      return;
    }
    const stage = `hub_policy.observe.${phase}`;
    options.stageRecorder.record(stage, {
      requestId: options.requestId,
      ...observation
    });
  } catch {
    // observe-only must never break the pipeline
  }
}

export function applyHubProviderOutboundPolicy(options: {
  policy?: HubPolicyConfig;
  providerProtocol: string;
  compatibilityProfile?: string;
  payload: JsonObject;
  stageRecorder?: StageRecorder;
  requestId?: string;
}): JsonObject {
  const effectivePolicy = resolveEffectivePolicy(options.policy);
  const mode = effectivePolicy?.mode ?? 'off';
  if (mode !== 'enforce') {
    return options.payload;
  }

  const normalizedProviderProtocol = normalizeHubProviderProtocol(options.providerProtocol);
  const compatibilityProfile =
    typeof options.compatibilityProfile === 'string' ? options.compatibilityProfile.trim().toLowerCase() : '';
  if (compatibilityProfile) {
    const overrides = getPolicyOverrides(policyCompatRegistry, compatibilityProfile);
    if (shouldSkipPolicy(overrides, 'enforce')) {
      return options.payload;
    }
  }

  const result = applyProviderOutboundPolicy(normalizedProviderProtocol, options.payload);
  if (!result.changed) {
    return options.payload;
  }
  try {
    options.stageRecorder?.record('hub_policy.enforce.provider_outbound', {
      requestId: options.requestId,
      providerProtocol: normalizedProviderProtocol,
      removedTopLevelKeys: result.removedTopLevelKeys,
      flattenedWrappers: result.flattenedWrappers
    });
  } catch {
    // policy enforcement recording must not break the pipeline
  }
  return result.payload;
}
