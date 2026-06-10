import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import type { JsonObject, JsonValue } from '../conversion/hub/types/json.js';
import { jsonClone } from '../conversion/hub/types/json.js';
import { planHubFollowupPolicyShadowWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';

export type HubFollowupMode = 'off' | 'shadow' | 'enforce';

export interface HubFollowupConfig {
  mode?: string;
  sampleRate?: unknown;
}

export function resolveHubFollowupConfigFromEnv(): HubFollowupConfig {
  const raw = String(process.env.ROUTECODEX_HUB_FOLLOWUP_MODE || '').trim();
  const sampleRateRaw = String(process.env.ROUTECODEX_HUB_FOLLOWUP_SAMPLE_RATE || '').trim();
  return {
    mode: raw,
    ...(sampleRateRaw ? { sampleRate: sampleRateRaw } : {})
  };
}

export function applyHubFollowupPolicyShadow(args: {
  config?: HubFollowupConfig;
  requestId?: string;
  entryEndpoint?: string;
  flowId?: string;
  payload: JsonObject;
  stageRecorder?: StageRecorder;
}): JsonObject {
  const cfg = args.config ?? resolveHubFollowupConfigFromEnv();
  const plan = planHubFollowupPolicyShadowWithNative({
    modeRaw: cfg.mode,
    sampleRateRaw: cfg.sampleRate,
    requestId: args.requestId,
    payload: args.payload as Record<string, unknown>
  });
  if (!plan.sampled) {
    return args.payload;
  }
  const candidate = plan.candidate as JsonObject;
  if (plan.shouldRecord) {
    const stage = `hub_followup.${plan.mode}.payload`;
    args.stageRecorder?.record(stage, {
      kind: 'hub_followup_payload_shadow',
      requestId: args.requestId,
      entryEndpoint: args.entryEndpoint,
      flowId: args.flowId,
      diffCount: plan.diffCount,
      diffPaths: plan.diffPaths,
      diffHead: plan.diffHead,
      baseline: jsonClone(args.payload as unknown as JsonValue),
      candidate: jsonClone(candidate as unknown as JsonValue)
    });
  }
  if (plan.shouldEnforce) {
    return candidate;
  }
  return args.payload;
}
