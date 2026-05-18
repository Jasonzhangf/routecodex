import { deriveFinishReason, STREAM_LOG_FINISH_REASON_KEY } from '../../../utils/finish-reason.js';

export const STREAM_CONTRACT_PROBE_BODY_KEY = '__routecodex_stream_contract_probe_body';

function buildStreamContractProbeBody(convertedBody: unknown): Record<string, unknown> | undefined {
  if (!convertedBody || typeof convertedBody !== 'object' || Array.isArray(convertedBody)) {
    return undefined;
  }
  const source = convertedBody as Record<string, unknown>;
  const probe: Record<string, unknown> = {};
  for (const key of [
    'choices',
    'status',
    'required_action',
    'output',
    'output_text',
    'reasoning',
    'content'
  ]) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      probe[key] = source[key];
    }
  }
  return Object.keys(probe).length > 0 ? probe : undefined;
}

export function buildServerToolSseWrapperBody(args: {
  sseResponses: unknown;
  convertedBody?: unknown;
  usage?: unknown;
}): Record<string, unknown> {
  const wrapperBody: Record<string, unknown> = {
    __sse_responses: args.sseResponses
  };
  if (args.usage !== undefined) {
    wrapperBody.usage = args.usage;
  }
  const finishReason = deriveFinishReason(args.convertedBody);
  if (finishReason) {
    wrapperBody[STREAM_LOG_FINISH_REASON_KEY] = finishReason;
  }
  const contractProbeBody = buildStreamContractProbeBody(args.convertedBody);
  if (contractProbeBody) {
    wrapperBody[STREAM_CONTRACT_PROBE_BODY_KEY] = contractProbeBody;
  }
  return wrapperBody;
}
