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
