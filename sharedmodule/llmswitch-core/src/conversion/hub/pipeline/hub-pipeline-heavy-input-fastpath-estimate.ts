function estimateTextTokens(value: unknown): number {
  if (typeof value === "string") {
    return Math.ceil(value.length / 4);
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateTextTokens(item), 0);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return Math.ceil(record.text.length / 4);
    }
    if (typeof record.content === "string") {
      return Math.ceil(record.content.length / 4);
    }
    let total = 0;
    for (const nested of Object.values(record)) {
      total += estimateTextTokens(nested);
    }
    return total;
  }
  return 0;
}

export function roughEstimateInputTokensFromRequest(request: unknown): number {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return 0;
  }
  const requestRecord = request as Record<string, unknown>;
  let total = 0;
  if (Array.isArray(requestRecord.messages)) {
    total += estimateTextTokens(requestRecord.messages);
  }
  if (Object.prototype.hasOwnProperty.call(requestRecord, "input")) {
    total += estimateTextTokens(requestRecord.input);
  }
  if (Object.prototype.hasOwnProperty.call(requestRecord, "instructions")) {
    total += estimateTextTokens(requestRecord.instructions);
  }
  if (total <= 0) {
    total += estimateTextTokens(requestRecord);
  }
  return Math.max(0, Math.floor(total));
}
