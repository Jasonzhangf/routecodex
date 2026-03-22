import type { JsonObject } from '../types/json.js';
import type { StageRecorder } from '../format-adapters/index.js';
import { recordHubPolicyObservation } from '../policy/policy-engine.js';
import { detectProviderResponseShapeWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';
import { summarizeToolCallsFromProviderResponseWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';

interface ToolSurfaceShadowOptions {
  enabled: boolean;
  stageRecorder?: StageRecorder;
  stageName: 'hub_toolsurface.shadow.provider_inbound' | 'hub_toolsurface.shadow.client_outbound';
  expectedProtocol: string;
  payload: JsonObject;
}

export function recordToolSurfaceShadowMismatch(options: ToolSurfaceShadowOptions): void {
  try {
    if (!options.stageRecorder || !options.enabled) {
      return;
    }
    const detected = detectProviderResponseShapeWithNative(options.payload);
    if (detected === 'unknown' || detected === options.expectedProtocol) {
      return;
    }
    const summary = summarizeToolCallsFromProviderResponseWithNative(options.payload);
    options.stageRecorder.record(options.stageName, {
      kind: options.stageName.endsWith('provider_inbound') ? 'provider_inbound' : 'client_outbound',
      expectedProtocol: options.expectedProtocol,
      detectedProtocol: detected,
      ...(summary.toolCallCount !== undefined ? { toolCallCount: summary.toolCallCount } : {}),
      ...(summary.toolNames ? { toolNames: summary.toolNames } : {})
    });
  } catch {
    // never break response conversion
  }
}

interface PolicyObservationOptions {
  phase: 'provider_inbound' | 'client_outbound';
  providerProtocol: string;
  payload: JsonObject;
  stageRecorder?: StageRecorder;
  requestId?: string;
}

export function recordPolicyObservationSafely(options: PolicyObservationOptions): void {
  try {
    if (!options.payload || typeof options.payload !== 'object' || Array.isArray(options.payload)) {
      return;
    }
    recordHubPolicyObservation({
      phase: options.phase,
      providerProtocol: options.providerProtocol,
      payload: options.payload,
      stageRecorder: options.stageRecorder,
      requestId: options.requestId
    });
  } catch {
    // never break response conversion
  }
}
