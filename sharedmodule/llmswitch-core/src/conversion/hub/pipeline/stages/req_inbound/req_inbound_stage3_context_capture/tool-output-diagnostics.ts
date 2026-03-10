import type { JsonObject } from '../../../../types/json.js';
import { injectReqInboundToolParseDiagnosticsWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

export function injectApplyPatchDiagnostics(payload: JsonObject): void {
  injectReqInboundToolParseDiagnosticsWithNative(payload as Record<string, unknown>);
}
