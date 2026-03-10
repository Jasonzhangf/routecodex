import { DetourRegistry } from './detour-registry.js';
import type { HubContext, HubDirection, StageSnapshotRecorder } from './hub-context.js';
import { jsonClone } from '../types/json.js';
import type { JsonValue } from '../types/json.js';
import { normalizeProviderProtocolTokenWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

export type HubStageKind = 'format' | 'semantic' | 'config';

export interface HubStageRuntime {
  readonly context: HubContext;
  readonly detours: DetourRegistry;
}

export interface HubStageDefinition {
  readonly name: string;
  readonly kind: HubStageKind;
  readonly direction: HubDirection;
  readonly execute: (input: JsonValue, runtime: HubStageRuntime) => Promise<JsonValue> | JsonValue;
}

export interface HubPlan {
  readonly protocol: string;
  readonly direction: HubDirection;
  readonly passthrough?: {
    readonly mode: 'identity' | 'clone';
  };
  readonly stages: readonly HubStageDefinition[];
}

export interface RunHubPlanOptions {
  readonly plan: HubPlan;
  readonly context: HubContext;
  readonly initialInput: JsonValue;
  readonly recorder?: StageSnapshotRecorder;
  readonly detours?: DetourRegistry;
}

function recordSnapshot(recorder: StageSnapshotRecorder | undefined, stage: string, ctx: HubContext, payload: JsonValue): void {
  if (!recorder) return;
  recorder.record({
    stage,
    protocol: ctx.protocol,
    direction: ctx.direction,
    payload: jsonClone(payload)
  });
}

export async function runHubPlan(options: RunHubPlanOptions): Promise<JsonValue> {
  const { plan, context, initialInput, recorder } = options;
  normalizeProviderProtocolTokenWithNative(plan.protocol || context.protocol);
  if (!plan.stages?.length && !plan.passthrough) {
    throw new Error(`Hub plan for ${plan.protocol} has neither stages nor passthrough`);
  }
  const detours = options.detours ?? new DetourRegistry();
  if (plan.passthrough) {
    const payload = plan.passthrough.mode === 'clone' ? jsonClone(initialInput) : initialInput;
    recordSnapshot(recorder, 'passthrough', context, payload);
    return payload;
  }
  let cursor: JsonValue = initialInput;
  const runtime = { context, detours } satisfies HubStageRuntime;
  for (const stage of plan.stages) {
    cursor = await stage.execute(cursor, runtime);
    recordSnapshot(recorder, stage.name, context, cursor);
  }
  return cursor;
}
