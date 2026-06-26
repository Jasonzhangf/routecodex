import { applyClientConnectionStateToContext } from '../../../utils/client-connection-state.js';
// feature_id: hub.metadata_center_servertool_context
import { resolveStopMessageClientInjectReadiness } from './client-injection-flow.js';
import { extractClientModelId } from './provider-response-utils.js';
import {
  readRuntimeControlProjection,
  readRuntimeServerToolProjection
} from '../metadata-center/request-truth-readers.js';
import { MetadataCenter } from '../metadata-center/metadata-center.js';

function asFlatRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

const SERVERTOOL_RUNTIME_CONTROL_METADATA_KEYS = [
  'serverToolFollowup',
  'serverToolFollowupSource',
  'serverToolFollowupMode',
  'servertoolResponseOrchestration',
  'serverToolLoopState',
  'stopMessageClientInject',
  'stopMessageClientInjectReady',
  'stopMessageClientInjectReason',
  'stopMessageClientInjectSessionScope',
  'stopMessageClientInjectTmuxSessionId',
] as const;

function stripServertoolRuntimeControlMetadataFields(metadata: Record<string, unknown>): void {
  for (const key of SERVERTOOL_RUNTIME_CONTROL_METADATA_KEYS) {
    delete metadata[key];
  }
}

function hasOwnRuntimeControlValue(
  center: MetadataCenter,
  key: 'serverToolFollowup' | 'stopMessageClientInject'
): boolean {
  const runtimeControl = center.snapshot().runtimeControl;
  return runtimeControl[key] !== undefined;
}

export function buildServerToolAdapterContext(args: {
  metadata?: Record<string, unknown>;
  entryOriginRequest?: Record<string, unknown>;
  requestSemantics?: Record<string, unknown>;
  requestId: string;
  entryEndpoint: string;
  providerProtocol: string;
  serverToolsEnabled?: boolean;
}): Record<string, unknown> {
  const metadataBag = asFlatRecord(args.metadata) ?? {};
  const baseContext: Record<string, unknown> = {
    ...metadataBag
  };
  stripServertoolRuntimeControlMetadataFields(baseContext);
  const inheritedRuntime = asFlatRecord(baseContext.__rt);
  if (inheritedRuntime) {
    stripServertoolRuntimeControlMetadataFields(inheritedRuntime);
    if (!Object.keys(inheritedRuntime).length) {
      delete baseContext.__rt;
    }
  }
  const metadataCenter = MetadataCenter.read(metadataBag);
  if (metadataCenter) {
    MetadataCenter.bind(baseContext, metadataCenter);
  } else {
    MetadataCenter.attach(baseContext);
  }
  const originRequest = args.entryOriginRequest;
  const originRecord = asFlatRecord(originRequest);
  if (!asFlatRecord(baseContext.capturedEntryRequest) && asFlatRecord(originRequest)) {
    baseContext.capturedEntryRequest = originRequest as Record<string, unknown>;
  }
  const existingCapturedChatRequest = asFlatRecord(baseContext.capturedChatRequest);
  if (originRecord && !existingCapturedChatRequest) {
    baseContext.capturedChatRequest = originRecord;
  }
  const serverToolProjection = readRuntimeServerToolProjection(metadataBag);
  if (serverToolProjection.sessionId) {
    baseContext.sessionId = serverToolProjection.sessionId;
  } else {
    delete baseContext.sessionId;
  }
  if (serverToolProjection.conversationId) {
    baseContext.conversationId = serverToolProjection.conversationId;
  } else {
    delete baseContext.conversationId;
  }
  const routeName = readNonEmptyString(metadataBag.routeName) ?? readNonEmptyString(metadataBag.routeHint);
  if (routeName) {
    baseContext.routeId = routeName;
  }
  baseContext.requestId = args.requestId;
  baseContext.entryEndpoint = args.entryEndpoint;
  const runtimeControl = readRuntimeControlProjection(metadataBag);
  const providerProtocol = typeof runtimeControl.providerProtocol === 'string' && runtimeControl.providerProtocol.trim()
    ? runtimeControl.providerProtocol.trim()
    : args.providerProtocol.trim();
  if (!providerProtocol) {
    throw new Error('Servertool adapter context requires providerProtocol');
  }
  const providerProtocolCenter = MetadataCenter.attach(baseContext);
  if (readRuntimeControlProjection(baseContext).providerProtocol !== providerProtocol) {
    providerProtocolCenter.writeRuntimeControl(
      'providerProtocol',
      providerProtocol,
      {
        module: 'src/server/runtime/http-server/executor/servertool-adapter-context.ts',
        symbol: 'buildServerToolAdapterContext',
        stage: 'ServertoolAdapterContextRuntimeControl'
      },
      'servertool adapter provider protocol seed'
    );
  }
  baseContext.providerProtocol = providerProtocol;

  const originalModelId = extractClientModelId(metadataBag, originRequest);
  if (originalModelId) {
    baseContext.originalModelId = originalModelId;
  }
  const assignedModelId = serverToolProjection.assignedModelId;
  if (assignedModelId) {
    baseContext.modelId = assignedModelId;
  }

  applyClientConnectionStateToContext(metadataBag, baseContext);

  const stopMessageInjectReadiness = resolveStopMessageClientInjectReadiness(baseContext);
  const clientProtocol = readNonEmptyString(metadataBag.clientProtocol);
  const baseCenter = MetadataCenter.attach(baseContext);
  if (
    runtimeControl.serverToolFollowup === true
    && !hasOwnRuntimeControlValue(baseCenter, 'serverToolFollowup')
  ) {
    baseCenter.writeRuntimeControl(
      'serverToolFollowup',
      true,
      {
        module: 'src/server/runtime/http-server/executor/servertool-adapter-context.ts',
        symbol: 'buildServerToolAdapterContext',
        stage: 'ServertoolAdapterContextRuntimeControl'
      },
      'servertool adapter context projection'
    );
  }
  if (!hasOwnRuntimeControlValue(baseCenter, 'stopMessageClientInject')) {
    baseCenter.writeRuntimeControl(
      'stopMessageClientInject',
      {
        ready: stopMessageInjectReadiness.ready,
        reason: stopMessageInjectReadiness.reason,
        ...(stopMessageInjectReadiness.sessionScope
          ? { sessionScope: stopMessageInjectReadiness.sessionScope }
          : {}),
        ...(stopMessageInjectReadiness.tmuxSessionId
          ? { tmuxSessionId: stopMessageInjectReadiness.tmuxSessionId }
          : {})
      },
      {
        module: 'src/server/runtime/http-server/executor/servertool-adapter-context.ts',
        symbol: 'buildServerToolAdapterContext',
        stage: 'ServertoolAdapterContextRuntimeControl'
      },
      'servertool adapter client inject readiness'
    );
  }
  if (clientProtocol) {
    baseContext.clientProtocol = clientProtocol;
  }

  const compatProfile = serverToolProjection.compatibilityProfile;
  if (compatProfile) {
    baseContext.compatibilityProfile = compatProfile;
  }

  if (typeof args.serverToolsEnabled === 'boolean') {
    baseContext.serverToolsEnabled = args.serverToolsEnabled;
    if (!args.serverToolsEnabled) {
      baseContext.serverToolsDisabled = true;
    } else if (Object.prototype.hasOwnProperty.call(baseContext, 'serverToolsDisabled')) {
      delete baseContext.serverToolsDisabled;
    }
  }

  return baseContext;
}
