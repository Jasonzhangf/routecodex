import type { PipelineExecutionInput, PipelineExecutionResult } from '../../handlers/types.js';

function readSessionToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function attachSessionHeaders(
  result: PipelineExecutionResult,
  metadata: Record<string, unknown> | undefined
): PipelineExecutionResult {
  const sessionId =
    readSessionToken(metadata?.sessionId)
    ?? readSessionToken(metadata?.session_id);
  const conversationId =
    readSessionToken(metadata?.conversationId)
    ?? readSessionToken(metadata?.conversation_id)
    ?? sessionId;
  if (!sessionId && !conversationId) {
    return result;
  }
  const headers: Record<string, string> = {
    ...(result.headers && typeof result.headers === 'object' ? result.headers : {})
  };
  if (sessionId && !readSessionToken(headers.session_id)) {
    headers.session_id = sessionId;
  }
  if (conversationId && !readSessionToken(headers.conversation_id)) {
    headers.conversation_id = conversationId;
  }
  return { ...result, headers };
}

export async function executePipelineViaLegacyOverride(
  server: any,
  input: PipelineExecutionInput,
  runHubPipelineFn: (input: PipelineExecutionInput, metadata: Record<string, unknown>) => Promise<any>
): Promise<PipelineExecutionResult> {
  const pipelineResult = await runHubPipelineFn(input, (input.metadata as Record<string, unknown>) ?? {});
  const target = pipelineResult?.target as { providerKey?: string; runtimeKey?: string; processMode?: string } | undefined;
  const providerKey = typeof target?.providerKey === 'string' ? target.providerKey : undefined;
  const providerKeyParts = providerKey ? providerKey.split('.') : [];
  const aliasScopedProviderKey = providerKeyParts.length >= 3 ? `${providerKeyParts[0]}.${providerKeyParts[1]}` : undefined;
  const runtimeKey =
    (providerKey ? server.providerKeyToRuntimeKey.get(providerKey) : undefined) ||
    (aliasScopedProviderKey ? server.providerKeyToRuntimeKey.get(aliasScopedProviderKey) : undefined) ||
    (typeof target?.runtimeKey === 'string' && target.runtimeKey.trim());
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
  return attachSessionHeaders(converted, (input.metadata as Record<string, unknown>) ?? {});
}
