import { deriveFinishReason, STREAM_LOG_FINISH_REASON_KEY } from '../../../utils/finish-reason.js';

export const STREAM_CONTRACT_PROBE_BODY_KEY = '__routecodex_stream_contract_probe_body';

function buildStreamContractProbeBody(convertedBody: unknown): Record<string, unknown> | undefined {
  if (!convertedBody || typeof convertedBody !== 'object' || Array.isArray(convertedBody)) {
    return undefined;
  }
  const source = convertedBody as Record<string, unknown>;
  const probe: Record<string, unknown> = {};
  for (const key of [
    'id',
    'object',
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
  return isMeaningfulStreamContractProbeBody(probe) ? probe : undefined;
}

function isMeaningfulStreamContractProbeBody(probe: Record<string, unknown>): boolean {
  if (Object.keys(probe).length === 0) {
    return false;
  }
  if (Array.isArray(probe.choices) && probe.choices.length > 0) {
    return true;
  }
  if (probe.required_action && typeof probe.required_action === 'object') {
    return true;
  }
  if (typeof probe.output_text === 'string' && probe.output_text.trim()) {
    return true;
  }
  if (Array.isArray(probe.output) && probe.output.length > 0) {
    return true;
  }
  const status = typeof probe.status === 'string' ? probe.status.trim().toLowerCase() : '';
  return status !== 'completed' && status !== 'stop';
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
