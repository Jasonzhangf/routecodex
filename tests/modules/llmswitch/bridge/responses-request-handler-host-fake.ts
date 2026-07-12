type AnyRecord = Record<string, unknown>;

function readTrimmedString(row: AnyRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function buildResponsesResumeControlForContinuationContextForHttpFake(
  resumeMeta: AnyRecord = {}
): AnyRecord {
  const out: AnyRecord = {};
  const copyString = (key: string): void => {
    const value = resumeMeta[key];
    if (typeof value === 'string' && value.trim()) {
      out[key] = value.trim();
    }
  };
  const copyBoolean = (key: string): void => {
    if (typeof resumeMeta[key] === 'boolean') {
      out[key] = resumeMeta[key];
    }
  };
  const copyNumber = (key: string): void => {
    if (typeof resumeMeta[key] === 'number' && Number.isFinite(resumeMeta[key])) {
      out[key] = resumeMeta[key];
    }
  };

  for (const key of [
    'responseId',
    'restoredFromResponseId',
    'previousRequestId',
    'requestId',
    'scopeKey',
    'entryKind',
    'continuationOwner',
    'materializedMode',
  ]) {
    copyString(key);
  }
  if (out.continuationOwner === 'direct') {
    copyString('providerKey');
  }
  for (const key of ['restored', 'materialized']) {
    copyBoolean(key);
  }
  for (const key of [
    'deltaInputItems',
    'toolOutputs',
    'incomingInputItems',
    'continuationDeltaItems',
    'fullInputItems',
  ]) {
    copyNumber(key);
  }

  const rawToolOutputs = resumeMeta.toolOutputsDetailed;
  if (Array.isArray(rawToolOutputs)) {
    const toolOutputsDetailed = rawToolOutputs.flatMap((item): AnyRecord[] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return [];
      }
      const row = item as AnyRecord;
      const callId = readTrimmedString(row, ['callId', 'originalId', 'call_id', 'tool_call_id', 'id']);
      const outputText = readTrimmedString(row, ['outputText', 'output_text', 'output']);
      if (!callId || !outputText) {
        return [];
      }
      const originalId = readTrimmedString(row, ['originalId', 'original_id']);
      return [{
        callId,
        ...(originalId ? { originalId } : {}),
        outputText,
      }];
    });
    if (toolOutputsDetailed.length > 0) {
      out.toolOutputsDetailed = toolOutputsDetailed;
    }
  }

  return out;
}

export function buildResponsesPipelineMetadataForHttpFake(args: {
  streamPlan?: AnyRecord;
  clientRequestId?: string;
  clientHeaders?: AnyRecord;
  clientAbort?: boolean;
  resumeMeta?: AnyRecord;
  responsesResume?: AnyRecord;
}): AnyRecord {
  const streamPlan = args.streamPlan ?? {};
  const responsesResume = args.responsesResume ?? (args.resumeMeta
    ? buildResponsesResumeControlForContinuationContextForHttpFake(args.resumeMeta)
    : undefined);
  const runtimeControlWrites = [
    {
      family: 'runtime_control',
      key: 'streamIntent',
      value: streamPlan.inboundStream === true || streamPlan.outboundStream === true ? 'stream' : 'non_stream',
      reason: 'responses handler stream intent',
    },
    {
      family: 'runtime_control',
      key: 'providerProtocol',
      value: 'openai-responses',
      reason: 'responses handler provider protocol',
    },
    {
      family: 'runtime_control',
      key: 'clientAbort',
      value: args.clientAbort === true,
      reason: 'responses handler client abort state',
    },
  ];
  if (
    responsesResume?.continuationOwner === 'direct'
    && typeof responsesResume.providerKey === 'string'
    && responsesResume.providerKey.trim()
  ) {
    runtimeControlWrites.push({
      family: 'runtime_control',
      key: 'retryProviderKey',
      value: responsesResume.providerKey.trim(),
      reason: 'direct responses continuation provider pin',
    });
  }
  return {
    metadata: {
      clientRequestId: args.clientRequestId,
      clientStream: streamPlan.acceptsSse === true ? true : undefined,
      clientHeaders: args.clientHeaders,
      ...(responsesResume ? { responsesResume } : {}),
    },
    metadataCenterWrites: [
      ...runtimeControlWrites,
      ...(responsesResume ? [{
        family: 'continuation_context',
        key: 'responsesResume',
        value: responsesResume,
      }] : []),
    ],
  };
}

export function finalizeResponsesHandlerPayloadForHttpFake(args: {
  payload?: AnyRecord;
  isSubmitToolOutputs?: boolean;
  outboundStream?: boolean;
}): AnyRecord {
  const payload = { ...(args.payload ?? {}) };
  if (args.isSubmitToolOutputs !== true && args.outboundStream === true && payload.stream !== true) {
    payload.stream = true;
  }
  return payload;
}
