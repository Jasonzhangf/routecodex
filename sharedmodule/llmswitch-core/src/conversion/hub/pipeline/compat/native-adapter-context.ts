import type { AdapterContext } from '../../types/chat-envelope.js';
import type { NativeReqOutboundCompatAdapterContextInput } from '../../../../native/router-hotpath/native-hub-pipeline-req-outbound-semantics.js';
import {
  readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter
} from '../../../../servertool/metadata-center-carrier.js';

// Thin TS bridge only carries metadata center bound context into native compat.

export function buildNativeReqOutboundCompatAdapterContext(
  adapterContext?: AdapterContext
): NativeReqOutboundCompatAdapterContextInput {
  const row = (adapterContext ?? {}) as Record<string, unknown>;
  const metadataCenterSnapshot = readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter(row)
    ?.metadataCenterSnapshot as Record<string, unknown> | undefined;
  const runtimeControl = metadataCenterSnapshot?.runtimeControl as Record<string, unknown> | undefined;
  const requestTruth = metadataCenterSnapshot?.requestTruth as Record<string, unknown> | undefined;
  const providerObservation = metadataCenterSnapshot?.providerObservation as Record<string, unknown> | undefined;
  const target = (() => {
    const value = providerObservation?.target;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  })();

  const readStringFrom = (source: Record<string, unknown> | undefined, key: string): string | undefined => {
    const value = source?.[key];
    return typeof value === 'string' && value.trim().length ? value.trim() : undefined;
  };

  return {
    compatibilityProfile: readStringFrom(providerObservation, 'compatibilityProfile'),
    providerProtocol: (() => {
      const providerProtocol =
        typeof runtimeControl?.providerProtocol === 'string' && runtimeControl.providerProtocol.trim()
          ? runtimeControl.providerProtocol.trim()
          : undefined;
      if (!providerProtocol) {
        throw new Error('Native req outbound compat adapter context requires metadata center runtime_control.providerProtocol');
      }
      return providerProtocol;
    })(),
    providerId: readStringFrom(target, 'providerId') ?? readStringFrom(target, 'id'),
    providerKey: readStringFrom(providerObservation, 'providerKey'),
    requestId: readStringFrom(requestTruth, 'requestId'),
    clientRequestId: readStringFrom(requestTruth, 'clientRequestId'),
    sessionId: readStringFrom(requestTruth, 'sessionId'),
    conversationId: readStringFrom(requestTruth, 'conversationId'),
    entryEndpoint: readStringFrom(requestTruth, 'entryEndpoint'),
    routeId: readStringFrom(runtimeControl, 'routeId'),
    modelId:
      readStringFrom(providerObservation, 'assignedModelId')
      ?? readStringFrom(providerObservation, 'modelId'),
    clientModelId: readStringFrom(providerObservation, 'clientModelId')
  };
}
