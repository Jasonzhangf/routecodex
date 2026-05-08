import { REASONING_STOP_FINALIZED_MARKER } from './servertool-response-normalizer.js';
import { formatUnknownError, isRecord } from '../../../../utils/common-utils.js';


function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function valueContainsReasoningStopFinalizedMarker(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes(REASONING_STOP_FINALIZED_MARKER);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => valueContainsReasoningStopFinalizedMarker(entry));
  }
  if (!isRecord(value)) {
    return false;
  }
  const entryType = readString(value.type)?.toLowerCase();
  if (
    entryType
    && entryType !== 'output_text'
    && entryType !== 'text'
    && entryType !== 'input_text'
    && entryType !== 'message'
  ) {
    return false;
  }
  if (valueContainsReasoningStopFinalizedMarker(value.output_text)) {
    return true;
  }
  if (valueContainsReasoningStopFinalizedMarker(value.text)) {
    return true;
  }
  if (entryType === 'message') {
    return valueContainsReasoningStopFinalizedMarker(value.content);
  }
  if (Array.isArray(value.content)) {
    return valueContainsReasoningStopFinalizedMarker(value.content);
  }
  return false;
}

export function bodyContainsReasoningStopFinalizedMarker(body: unknown): boolean {
  if (!isRecord(body)) {
    return false;
  }
  const choices = Array.isArray(body.choices) ? body.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice)) {
      continue;
    }
    const message = isRecord(choice.message) ? choice.message : undefined;
    if (message && valueContainsReasoningStopFinalizedMarker(message.content)) {
      return true;
    }
  }
  if (valueContainsReasoningStopFinalizedMarker(body.output_text)) {
    return true;
  }
  const output = Array.isArray(body.output) ? body.output : [];
  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    if (valueContainsReasoningStopFinalizedMarker(item.output_text)) {
      return true;
    }
    if (valueContainsReasoningStopFinalizedMarker(item.text)) {
      return true;
    }
    if (valueContainsReasoningStopFinalizedMarker(item.content)) {
      return true;
    }
  }
  return false;
}
