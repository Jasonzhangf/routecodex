import { readString } from './request-executor-error-shared.js';
import { formatUnknownError, isRecord } from '../../../../utils/common-utils.js';


function valueHasNonEmptyText(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueHasNonEmptyText(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  return (
    valueHasNonEmptyText(value.text)
    || valueHasNonEmptyText(value.output_text)
    || valueHasNonEmptyText(value.content)
    || valueHasNonEmptyText(value.reasoning_content)
    || valueHasNonEmptyText(value.reasoning)
  );
}

function extractTextFromResponsesOutputItem(item: unknown): string {
  if (!isRecord(item)) {
    return '';
  }
  const itemType = readString(item.type)?.toLowerCase();
  const directOutputText = readString(item.output_text);
  if (directOutputText) {
    return directOutputText;
  }
  if (itemType === 'output_text' || itemType === 'text' || itemType === 'input_text') {
    const direct = readString(item.text);
    if (direct) {
      return direct;
    }
  }
  if (itemType === 'message') {
    const content = Array.isArray(item.content) ? item.content : [];
    const chunks: string[] = [];
    for (const part of content) {
      if (!isRecord(part)) {
        continue;
      }
      const partType = readString(part.type)?.toLowerCase();
      if (partType && partType !== 'output_text' && partType !== 'text' && partType !== 'input_text') {
        continue;
      }
      const partText = readString(part.text) ?? readString(part.output_text);
      if (partText) {
        chunks.push(partText);
      }
    }
    return chunks.join('');
  }
  return '';
}

export function backfillResponsesOutputTextIfMissing(body: unknown): void {
  if (!isRecord(body) || valueHasNonEmptyText(body.output_text)) {
    return;
  }
  const outputItems = Array.isArray(body.output) ? body.output : [];
  if (outputItems.length <= 0) {
    return;
  }
  const text = outputItems
    .map((item) => extractTextFromResponsesOutputItem(item))
    .join('')
    .trim();
  if (!text) {
    return;
  }
  body.output_text = text;
}
