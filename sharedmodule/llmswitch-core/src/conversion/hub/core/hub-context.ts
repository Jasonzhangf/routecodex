import type { JsonObject, JsonValue } from '../types/json.js';
import type { NativeProviderProtocolToken } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

export type HubDirection = 'inbound' | 'outbound';
export type HubNativeProtocolToken = NativeProviderProtocolToken;

export interface HubContext {
  readonly requestId: string;
  readonly protocol: HubNativeProtocolToken;
  readonly direction: HubDirection;
  readonly routeId?: string;
  readonly providerId?: string;
  readonly profileId?: string;
  readonly endpoint?: string;
  readonly metadata?: JsonObject;
}

export interface StageSnapshot {
  readonly stage: string;
  readonly protocol: string;
  readonly direction: HubDirection;
  readonly payload: JsonValue;
}

export interface StageSnapshotRecorder {
  record(snapshot: StageSnapshot): void;
}
