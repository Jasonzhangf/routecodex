import type { AdapterContext } from '../types/chat-envelope.js';
import { readRuntimeMetadata } from '../../runtime-metadata.js';
import {
  resolveProviderResponseContextHelpersWithNative
} from '../../../native/router-hotpath/native-hub-pipeline-resp-semantics.js';

export type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';
type ClientProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

interface ProviderResponseContextSignals {
  isFollowup: boolean;
  toolSurfaceShadowEnabled: boolean;
  clientProtocol: ClientProtocol;
  displayModel?: string;
  clientFacingRequestId: string;
}

export function resolveProviderResponseContextSignals(
  context: AdapterContext,
  entryEndpoint?: string
): ProviderResponseContextSignals {
  void readRuntimeMetadata;
  const resolved = resolveProviderResponseContextHelpersWithNative({
    context,
    legacyFollowupMarkerRaw: null,
    entryEndpoint,
    toolSurfaceModeRaw: String(process.env.ROUTECODEX_HUB_TOOL_SURFACE_MODE || '')
  });
  if (typeof resolved.clientFacingRequestId !== 'string' || !resolved.clientFacingRequestId) {
    throw new Error('Rust provider response context helper returned no client-facing request id');
  }
  return {
    isFollowup: resolved.isServerToolFollowup === true,
    toolSurfaceShadowEnabled: resolved.toolSurfaceShadowEnabled === true,
    clientProtocol: resolved.clientProtocol,
    ...(resolved.displayModel ? { displayModel: resolved.displayModel } : {}),
    clientFacingRequestId: resolved.clientFacingRequestId
  };
}
