import type { StageRecorder } from '../../../../format-adapters/index.js';
import type { ProcessedRequest, StandardizedRequest } from '../../../../types/standardized.js';
import type {
  RouterMetadataInput,
  RoutingDecision,
  RoutingDiagnostics,
  TargetMetadata
} from '../../../../../../router/virtual-router/types.js';
import { VirtualRouterEngine } from '../../../../../../router/virtual-router/engine.js';
import { recordStage } from '../../../stages/utils.js';
import { applyReqProcessRouteSelectionWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-process-semantics.js';
import { cleanMarkerSyntaxInPlace } from '../../../../../shared/marker-lifecycle.js';

export interface ReqProcessStage2RouteSelectOptions {
  routerEngine: VirtualRouterEngine;
  request: StandardizedRequest | ProcessedRequest;
  metadataInput: RouterMetadataInput;
  normalizedMetadata: Record<string, unknown>;
  stageRecorder?: StageRecorder;
}

export interface ReqProcessStage2RouteSelectResult {
  target: TargetMetadata;
  decision: RoutingDecision;
  diagnostics: RoutingDiagnostics;
}

function replaceRecordInPlace(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      delete target[key];
    }
  }
  Object.assign(target, source);
}

export function runReqProcessStage2RouteSelect(
  options: ReqProcessStage2RouteSelectOptions
): ReqProcessStage2RouteSelectResult {
  const previousModel = typeof options.request.model === 'string' ? options.request.model : undefined;
  const result = options.routerEngine.route(options.request, options.metadataInput);
  const nativeApplied = applyReqProcessRouteSelectionWithNative(
    {
      request: options.request as unknown as Record<string, unknown>,
      normalizedMetadata: options.normalizedMetadata,
      target: result.target as unknown as Record<string, unknown>,
      routeName: result.decision.routeName,
      originalModel: previousModel
    }
  );
  cleanMarkerSyntaxInPlace(nativeApplied.request as Record<string, unknown>);
  replaceRecordInPlace(options.request as unknown as Record<string, unknown>, nativeApplied.request as Record<string, unknown>);
  replaceRecordInPlace(options.normalizedMetadata, nativeApplied.normalizedMetadata);
  recordStage(options.stageRecorder, 'chat_process.req.stage5.route_select', {
    target: result.target,
    decision: result.decision,
    diagnostics: result.diagnostics
  });
  return {
    target: result.target,
    decision: result.decision,
    diagnostics: result.diagnostics
  };
}
