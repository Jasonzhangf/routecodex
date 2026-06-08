import type { AdapterContext } from '../types/chat-envelope.js';
import { readRuntimeMetadata } from '../../runtime-metadata.js';
import {
  resolveProviderResponseContextHelpersWithNative
} from '../../../native/router-hotpath/native-hub-pipeline-resp-semantics.js';

export type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';
export type ClientProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export interface ProviderResponseContextSignals {
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
  const runtimeMeta = readRuntimeMetadata(context as unknown as Record<string, unknown>);
  const resolved = resolveProviderResponseContextHelpersWithNative({
    context,
    serverToolFollowupRaw: (runtimeMeta as any)?.serverToolFollowup,
    entryEndpoint,
    toolSurfaceModeRaw: String(process.env.ROUTECODEX_HUB_TOOL_SURFACE_MODE || '')
  });
  const clientFacingRequestId =
    typeof resolved.clientFacingRequestId === 'string' && resolved.clientFacingRequestId.trim()
      ? resolved.clientFacingRequestId.trim()
      : context.requestId;
  const clientProtocol: ClientProtocol =
    resolved.clientProtocol === 'openai-responses' || resolved.clientProtocol === 'anthropic-messages'
      ? resolved.clientProtocol
      : 'openai-chat';
  return {
    isFollowup: resolved.isServerToolFollowup === true,
    toolSurfaceShadowEnabled: resolved.toolSurfaceShadowEnabled === true,
    clientProtocol,
    displayModel:
      typeof resolved.displayModel === 'string' && resolved.displayModel.trim()
        ? resolved.displayModel.trim()
        : undefined,
    clientFacingRequestId
  };
}
