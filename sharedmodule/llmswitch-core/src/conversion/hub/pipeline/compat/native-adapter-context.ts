import type { AdapterContext } from '../../types/chat-envelope.js';
import {
  buildNativeReqOutboundCompatAdapterContextWithNative,
  type NativeReqOutboundCompatAdapterContextInput
} from '../../../../native/router-hotpath/native-hub-pipeline-req-outbound-semantics.js';
import {
  readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter
} from '../../metadata-center-runtime-control-writer.js';

// Thin TS bridge only carries metadata center bound context into native compat.

export function buildNativeReqOutboundCompatAdapterContext(
  adapterContext?: AdapterContext
): NativeReqOutboundCompatAdapterContextInput {
  const row = (adapterContext ?? {}) as Record<string, unknown>;
  const metadataCenterSnapshot =
    readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter(row)?.metadataCenterSnapshot;
  return buildNativeReqOutboundCompatAdapterContextWithNative({
    metadataCenterSnapshot: metadataCenterSnapshot ?? null
  });
}
