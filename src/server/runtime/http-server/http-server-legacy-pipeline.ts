import type { PipelineExecutionInput, PipelineExecutionResult } from '../../handlers/types.js';

export async function executePipelineViaLegacyOverride(
  server: any,
  input: PipelineExecutionInput,
  runHubPipelineFn: (input: PipelineExecutionInput, metadata: Record<string, unknown>) => Promise<any>
): Promise<PipelineExecutionResult> {
  const pipelineResult = await runHubPipelineFn(input, (input.metadata as Record<string, unknown>) ?? {});
  const target = pipelineResult?.target as { providerKey?: string; runtimeKey?: string; processMode?: string } | undefined;
  const runtimeKey =
    (typeof target?.runtimeKey === 'string' && target.runtimeKey.trim()) ||
    (typeof target?.providerKey === 'string' ? server.providerKeyToRuntimeKey.get(target.providerKey) : undefined);
  if (!runtimeKey) {
    throw new Error(`Runtime for provider ${target?.providerKey || 'unknown'} not initialized`);
  }
  const handle = server.providerHandles.get(runtimeKey);
  if (!handle) {
    throw new Error(`Provider runtime ${runtimeKey} not found`);
  }
  const providerResponse = await handle.instance.processIncoming(pipelineResult.providerPayload);
  const normalized: PipelineExecutionResult =
    providerResponse && typeof providerResponse === 'object' && 'data' in (providerResponse as Record<string, unknown>)
      ? {
          status:
            typeof (providerResponse as { status?: unknown }).status === 'number'
              ? (providerResponse as { status: number }).status
              : undefined,
          headers:
            (providerResponse as { headers?: unknown }).headers &&
            typeof (providerResponse as { headers?: unknown }).headers === 'object'
              ? ((providerResponse as { headers: Record<string, string> }).headers)
              : undefined,
          body: (providerResponse as Record<string, unknown>).data
        }
      : {
          status:
            typeof (providerResponse as { status?: unknown }).status === 'number'
              ? (providerResponse as { status: number }).status
              : undefined,
          headers:
            (providerResponse as { headers?: unknown }).headers &&
            typeof (providerResponse as { headers?: unknown }).headers === 'object'
              ? ((providerResponse as { headers: Record<string, string> }).headers)
              : undefined,
          body: providerResponse
        };

  const maybeConvert = (server as { convertProviderResponseIfNeeded?: unknown }).convertProviderResponseIfNeeded;
  const converted =
    Object.prototype.hasOwnProperty.call(server as object, 'convertProviderResponseIfNeeded') &&
    typeof maybeConvert === 'function'
      ? await (maybeConvert as (opts: Record<string, unknown>) => Promise<PipelineExecutionResult>)({
          entryEndpoint: input.entryEndpoint,
          providerType: handle.providerType,
          requestId: input.requestId,
          wantsStream: Boolean(input.metadata?.inboundStream ?? input.metadata?.stream),
          response: normalized,
          processMode: pipelineResult?.processMode,
          pipelineMetadata: pipelineResult?.metadata
        })
      : normalized;

  const metadata = (input.metadata as Record<string, unknown>) ?? {};
  const sessionId = typeof metadata.sessionId === 'string' && metadata.sessionId.trim() ? metadata.sessionId.trim() : undefined;
  let conversationId =
    typeof metadata.conversationId === 'string' && metadata.conversationId.trim() ? metadata.conversationId.trim() : undefined;
  if (!conversationId && sessionId) {
    conversationId = sessionId;
  }
  if (sessionId || conversationId) {
    converted.headers = converted.headers ?? {};
    if (sessionId && !converted.headers.session_id) {
      converted.headers.session_id = sessionId;
    }
    if (conversationId && !converted.headers.conversation_id) {
      converted.headers.conversation_id = conversationId;
    }
  }
  return converted;
}
