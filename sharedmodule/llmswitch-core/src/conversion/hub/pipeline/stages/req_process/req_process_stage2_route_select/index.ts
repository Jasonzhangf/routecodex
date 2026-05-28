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

function readPreselectedRoute(
  metadataInput: RouterMetadataInput,
  normalizedMetadata: Record<string, unknown>
): { target: TargetMetadata; decision: RoutingDecision; diagnostics: RoutingDiagnostics } | undefined {
  const candidate =
    (metadataInput as unknown as Record<string, unknown>).__routecodexPreselectedRoute
    ?? normalizedMetadata.__routecodexPreselectedRoute;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined;
  }
  const record = candidate as Record<string, unknown>;
  const target = record.target;
  const decision = record.decision;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw Object.assign(new Error('[HubPipeline] preselected route target is invalid'), {
      code: 'ERR_PRESELECTED_ROUTE_TARGET_INVALID'
    });
  }
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw Object.assign(new Error('[HubPipeline] preselected route decision is invalid'), {
      code: 'ERR_PRESELECTED_ROUTE_DECISION_INVALID'
    });
  }
  return {
    target: target as TargetMetadata,
    decision: decision as RoutingDecision,
    diagnostics:
      record.diagnostics && typeof record.diagnostics === 'object' && !Array.isArray(record.diagnostics)
        ? (record.diagnostics as RoutingDiagnostics)
        : ({} as RoutingDiagnostics)
  };
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
  const preselected = readPreselectedRoute(options.metadataInput, options.normalizedMetadata);
  const result = preselected ?? options.routerEngine.route(options.request, options.metadataInput);
  const nativeApplied = applyReqProcessRouteSelectionWithNative(
    {
      request: options.request as unknown as Record<string, unknown>,
      normalizedMetadata: options.normalizedMetadata,
      target: result.target as unknown as Record<string, unknown>,
      routeName: result.decision.routeName,
      originalModel: previousModel,
      thinking: ((result.target as unknown as Record<string, unknown>)?.thinking as string | undefined)
    }
  );
  cleanMarkerSyntaxInPlace(nativeApplied.request as Record<string, unknown>);
  replaceRecordInPlace(options.request as unknown as Record<string, unknown>, nativeApplied.request as Record<string, unknown>);
  replaceRecordInPlace(options.normalizedMetadata, nativeApplied.normalizedMetadata);
  recordStage(options.stageRecorder, 'chat_process.req.stage5.route_select', {
    target: result.target,
    decision: result.decision,
    diagnostics: result.diagnostics,
    reusedPreselectedRoute: preselected !== undefined
  });
  return {
    target: result.target,
    decision: result.decision,
    diagnostics: result.diagnostics
  };
}
