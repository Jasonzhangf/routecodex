export const DEFAULT_DELIVERY_HISTORY_LIMIT = 10;

function normalizeText(input: string): string {
  return String(input || "").replace(/\r\n/g, "\n");
}

function findSectionIndices(lines: string[]): number[] {
  const indices: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index] || "")) {
      indices.push(index);
    }
  }
  return indices;
}

export function pruneDeliveryLogText(
  input: string,
  options?: { keepRecentRuns?: number },
): string {
  const text = normalizeText(input);
  const keepRecentRunsRaw = Number(options?.keepRecentRuns);
  const keepRecentRuns =
    Number.isFinite(keepRecentRunsRaw) && keepRecentRunsRaw > 0
      ? Math.floor(keepRecentRunsRaw)
      : DEFAULT_DELIVERY_HISTORY_LIMIT;

  if (!text.trim()) {
    return text;
  }

  const lines = text.split("\n");
  const sectionIndices = findSectionIndices(lines);
  if (sectionIndices.length <= keepRecentRuns) {
    return text;
  }

  const firstSectionIndex = sectionIndices[0] ?? 0;
  const keepFromSectionIndex = sectionIndices[sectionIndices.length - keepRecentRuns] ?? 0;
  const headerLines = lines.slice(0, firstSectionIndex);
  const keptSections = lines.slice(keepFromSectionIndex);

  let header = headerLines.join("\n").replace(/\s+$/g, "");
  const body = keptSections.join("\n").replace(/^\s+/, "");
  if (!header) {
    return body;
  }
  return `${header}\n\n${body}`;
}
