import type { ProviderStatsBucketLike, ProviderStatsViewLike } from './stats-manager-internals.js';

type ProviderSummaryTableRow = {
  providerKey: string;
  model: string;
  requests: string;
  ok: string;
  err: string;
  avgLatencyMs: string;
  avgTokens: string;
  totalTokens: string;
  window?: string;
};

type SummaryTableColumn = {
  key: keyof ProviderSummaryTableRow;
  title: string;
  align: 'left' | 'right';
  maxWidth?: number;
};

export function buildSessionProviderRow(bucket: ProviderStatsViewLike): Record<string, string> {
  const okCount = bucket.requestCount - bucket.errorCount;
  return {
    providerKey: normalizeCellValue(bucket.providerKey),
    model: normalizeCellValue(bucket.model),
    requests: String(bucket.requestCount),
    ok: String(okCount),
    err: String(bucket.errorCount),
    avgLatencyMs: bucket.averageLatencyMs.toFixed(1),
    avgTokens: formatAverageTokenTriple(
      bucket.averagePromptTokens,
      bucket.averageCompletionTokens,
      bucket.averageOutputTokens
    ),
    totalTokens: formatTotalTokenTriple(
      bucket.totalPromptTokens,
      bucket.totalCompletionTokens,
      bucket.totalOutputTokens
    )
  };
}

export function buildHistoricalProviderRow(bucket: ProviderStatsBucketLike): Record<string, string> {
  const okCount = bucket.requestCount - bucket.errorCount;
  const avgLatency = bucket.requestCount ? bucket.totalLatencyMs / bucket.requestCount : 0;
  const avgPrompt = bucket.requestCount ? bucket.totalPromptTokens / bucket.requestCount : 0;
  const avgCompletion = bucket.requestCount ? bucket.totalCompletionTokens / bucket.requestCount : 0;
  const avgTotal = bucket.requestCount ? bucket.totalOutputTokens / bucket.requestCount : 0;
  return {
    providerKey: normalizeCellValue(bucket.providerKey),
    model: normalizeCellValue(bucket.model),
    requests: String(bucket.requestCount),
    ok: String(okCount),
    err: String(bucket.errorCount),
    avgLatencyMs: avgLatency.toFixed(1),
    avgTokens: formatAverageTokenTriple(avgPrompt, avgCompletion, avgTotal),
    totalTokens: formatTotalTokenTriple(
      bucket.totalPromptTokens,
      bucket.totalCompletionTokens,
      bucket.totalOutputTokens
    ),
    window: formatWindowRange(bucket.firstRequestAt, bucket.lastRequestAt)
  };
}

export function logProviderSummaryTable(rows: Array<Record<string, string>>, includeWindow: boolean): void {
  if (!rows.length) {
    return;
  }

  const columns: SummaryTableColumn[] = [
    { key: 'providerKey', title: 'providerKey', align: 'left', maxWidth: 44 },
    { key: 'model', title: 'model', align: 'left', maxWidth: 28 },
    { key: 'requests', title: 'req', align: 'right' },
    { key: 'ok', title: 'ok', align: 'right' },
    { key: 'err', title: 'err', align: 'right' },
    { key: 'avgLatencyMs', title: 'avgMs', align: 'right' },
    { key: 'avgTokens', title: 'avgTok(i/o/t)', align: 'right', maxWidth: 22 },
    { key: 'totalTokens', title: 'totTok(i/o/t)', align: 'right', maxWidth: 22 }
  ];
  if (includeWindow) {
    columns.push({ key: 'window', title: 'window', align: 'left', maxWidth: 41 });
  }

  const widths = columns.map((column) => {
    const maxCellLength = rows.reduce((maxLength, row) => {
      const value = normalizeCellValue(row[column.key]);
      const clipped = clipCellValue(value, column.maxWidth);
      return Math.max(maxLength, clipped.length);
    }, column.title.length);
    if (typeof column.maxWidth === 'number' && column.maxWidth > 0) {
      return Math.min(Math.max(column.title.length, maxCellLength), column.maxWidth);
    }
    return Math.max(column.title.length, maxCellLength);
  });

  console.log(renderTableRow(columns, widths, undefined, true));
  console.log(renderTableSeparator(widths));
  for (const row of rows) {
    console.log(renderTableRow(columns, widths, row as ProviderSummaryTableRow, false));
  }
}

function renderTableRow(
  columns: SummaryTableColumn[],
  widths: number[],
  row: ProviderSummaryTableRow | undefined,
  isHeader: boolean
): string {
  const cells = columns.map((column, index) => {
    const value = isHeader ? column.title : normalizeCellValue(row?.[column.key]);
    const clipped = clipCellValue(value, widths[index]);
    return column.align === 'right'
      ? clipped.padStart(widths[index], ' ')
      : clipped.padEnd(widths[index], ' ');
  });
  return `  | ${cells.join(' | ')} |`;
}

function renderTableSeparator(widths: number[]): string {
  return `  |-` + widths.map((width) => '-'.repeat(width)).join('-|-') + '-|';
}

function clipCellValue(value: string, maxWidth?: number): string {
  if (!Number.isFinite(maxWidth) || typeof maxWidth !== 'number' || maxWidth <= 0) {
    return value;
  }
  if (value.length <= maxWidth) {
    return value;
  }
  if (maxWidth <= 1) {
    return '…';
  }
  if (maxWidth <= 3) {
    return value.slice(0, maxWidth);
  }
  return `${value.slice(0, maxWidth - 1)}…`;
}

function normalizeCellValue(value: string | number | undefined): string {
  if (value === undefined || value === null) {
    return '-';
  }
  const normalized = String(value).trim();
  return normalized.length ? normalized : '-';
}

function formatAverageTokenTriple(prompt: number, completion: number, total: number): string {
  if (prompt === 0 && completion === 0 && total === 0) {
    return '-';
  }
  return `${prompt.toFixed(1)}/${completion.toFixed(1)}/${total.toFixed(1)}`;
}

function formatTotalTokenTriple(prompt: number, completion: number, total: number): string {
  if (prompt === 0 && completion === 0 && total === 0) {
    return '-';
  }
  return `${prompt}/${completion}/${total}`;
}

function formatWindowRange(firstAt: number, lastAt: number): string {
  return `${formatIso(firstAt)}→${formatIso(lastAt)}`;
}

export function formatProviderLabel(providerKey?: string, model?: string): string {
  const key = typeof providerKey === 'string' && providerKey.trim() ? providerKey.trim() : '-';
  const modelId = typeof model === 'string' && model.trim() ? model.trim() : undefined;
  if (modelId) {
    return `${key} / ${modelId}`;
  }
  return key;
}

export function formatIso(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return '-';
  }
  try {
    return new Date(value).toISOString();
  } catch {
    return '-';
  }
}
