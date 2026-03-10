import type { AdapterContext } from '../../hub/types/chat-envelope.js';
import type { ProtocolPipelineContext } from './protocol-hooks.js';

export interface AdapterContextOptions {
  defaultEntryEndpoint?: string;
  overrideProtocol?: string;
}

export function buildAdapterContextFromPipeline(
  context: ProtocolPipelineContext,
  options?: AdapterContextOptions
): AdapterContext {
  const requestId = context.requestId ?? `req_${Date.now()}`;
  const entryEndpoint =
    options?.defaultEntryEndpoint ??
    context.entryEndpoint ??
    '/v1/chat/completions';
  const providerProtocol =
    options?.overrideProtocol ??
    context.providerProtocol ??
    context.targetProtocol ??
    'openai-chat';
  const streamingHint = context.stream === true ? 'force' : context.stream === false ? 'disable' : 'auto';

  return {
    requestId,
    entryEndpoint,
    providerProtocol,
    profileId: context.profileId,
    streamingHint
  };
}
