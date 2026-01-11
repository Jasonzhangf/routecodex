#!/usr/bin/env tsx
/**
 * Generate a tool classification report for codex samples using the
 * virtual router tool classifier (read/write/search/other).
 *
 * Usage:
 *   npx tsx scripts/tool-classification-report.ts [samplesRoot] [outputFile]
 *
 * Defaults:
 *   samplesRoot = ~/.routecodex/codex-samples
 *   outputFile  = ./reports/tool-classification-report.md
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

import {
  canonicalizeToolName,
  classifyToolCallForReport,
  type ToolCategory
} from '../sharedmodule/llmswitch-core/src/router/virtual-router/tool-signals.js';

type CategoryCounts = Record<ToolCategory, number>;

type ExampleEntry = {
  category: ToolCategory;
  file: string;
  snippet?: string;
};

type ToolSummary = {
  total: number;
  categories: CategoryCounts;
  examples: Record<ToolCategory, ExampleEntry[]>;
};

const CATEGORY_KEYS: ToolCategory[] = ['websearch', 'read', 'write', 'search', 'other'];
const SAMPLE_SUFFIX = '_req_process_tool_filters_request_pre.json';
const EXAMPLE_LIMIT = 5;

async function main(): Promise<void> {
  const [, , rootArg, outputArg] = process.argv;
  const sampleRoot = rootArg || path.join(os.homedir(), '.routecodex', 'codex-samples');
  const outputFile = outputArg || path.join(process.cwd(), 'reports', 'tool-classification-report.md');

  if (!fs.existsSync(sampleRoot)) {
    throw new Error(`Sample root not found: ${sampleRoot}`);
  }

  const files = await collectSampleFiles(sampleRoot);
  files.sort((a, b) => a.localeCompare(b));

  const processedRequests = new Set<string>();
  const summary = new Map<string, ToolSummary>();
  const categoryTotals: CategoryCounts = emptyCounts();
  let totalCalls = 0;
  let classifiedCalls = 0;
  let unclassifiedCalls = 0;
  let skippedDuplicates = 0;

  for (const filePath of files) {
    const requestKey = extractRequestKey(filePath);
    if (processedRequests.has(requestKey)) {
      skippedDuplicates += 1;
      continue;
    }
    processedRequests.add(requestKey);

    const data = await readJsonSafe(filePath);
    if (!data) {
      continue;
    }
    const messages = Array.isArray(data.messages) ? data.messages : [];
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') {
        continue;
      }
      if (msg.role !== 'assistant') {
        continue;
      }
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      for (const call of toolCalls) {
        totalCalls += 1;
        const classification = classifyToolCallForReport(call as any);
        if (!classification) {
          unclassifiedCalls += 1;
          continue;
        }
        classifiedCalls += 1;
        const toolName = canonicalizeToolName(classification.name ?? '') || '(unknown)';
        const entry = ensureSummary(summary, toolName);
        entry.total += 1;
        entry.categories[classification.category] += 1;
        categoryTotals[classification.category] += 1;
        const examples = entry.examples[classification.category];
        if (examples.length < EXAMPLE_LIMIT) {
          examples.push({
            category: classification.category,
            file: path.relative(sampleRoot, filePath),
            snippet: classification.commandSnippet || buildFallbackSnippet(call)
          });
        }
      }
    }
  }

  const orderedSummaries = Array.from(summary.entries()).sort((a, b) => b[1].total - a[1].total);
  const report = buildReport({
    sampleRoot,
    outputFile,
    filesScanned: files.length,
    uniqueRequests: processedRequests.size,
    skippedDuplicates,
    totalCalls,
    classifiedCalls,
    unclassifiedCalls,
    categoryTotals,
    summaries: orderedSummaries
  });

  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, report.join('\n'), 'utf8');
  console.log(`[tool-classification-report] wrote ${outputFile}`);
}

function emptyCounts(): CategoryCounts {
  return { websearch: 0, read: 0, write: 0, search: 0, other: 0 };
}

function emptyExampleBuckets(): Record<ToolCategory, ExampleEntry[]> {
  return {
    websearch: [],
    read: [],
    write: [],
    search: [],
    other: []
  };
}

function ensureSummary(summary: Map<string, ToolSummary>, name: string): ToolSummary {
  if (!summary.has(name)) {
    summary.set(name, {
      total: 0,
      categories: emptyCounts(),
      examples: emptyExampleBuckets()
    });
  }
  return summary.get(name)!;
}

async function collectSampleFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectSampleFiles(fullPath);
      files.push(...nested);
    } else if (entry.isFile() && entry.name.endsWith(SAMPLE_SUFFIX)) {
      files.push(fullPath);
    }
  }
  return files;
}

async function readJsonSafe(filePath: string): Promise<any | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractRequestKey(filePath: string): string {
  const base = path.basename(filePath);
  const match = base.match(/^(req_[^_]+_[^_]+)/);
  return match ? match[1] : base;
}

function sanitizeSnippet(snippet?: string): string {
  if (!snippet) {
    return '(no snippet)';
  }
  return snippet.replace(/[\r\n]+/g, ' ').replace(/`/g, "'");
}

function titleCase(category: ToolCategory): string {
  if (category === 'websearch') {
    return 'WebSearch';
  }
  return category.charAt(0).toUpperCase() + category.slice(1);
}

function buildFallbackSnippet(call: any): string | undefined {
  const rawArgs = call?.function?.arguments;
  if (typeof rawArgs === 'string' && rawArgs.trim()) {
    const trimmed = rawArgs.trim().replace(/\s+/g, ' ');
    return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
  }
  return undefined;
}

function buildReport(options: {
  sampleRoot: string;
  outputFile: string;
  filesScanned: number;
  uniqueRequests: number;
  skippedDuplicates: number;
  totalCalls: number;
  classifiedCalls: number;
  unclassifiedCalls: number;
  categoryTotals: CategoryCounts;
  summaries: Array<[string, ToolSummary]>;
}): string[] {
  const {
    sampleRoot,
    filesScanned,
    uniqueRequests,
    skippedDuplicates,
    totalCalls,
    classifiedCalls,
    unclassifiedCalls,
    categoryTotals,
    summaries
  } = options;

  const lines: string[] = [];
  lines.push('# Tool Classification Report');
  lines.push('');
  lines.push(`- Sample root: ${sampleRoot}`);
  lines.push(`- Files scanned: ${filesScanned}`);
  lines.push(`- Unique requests: ${uniqueRequests}`);
  lines.push(`- Skipped duplicates: ${skippedDuplicates}`);
  lines.push(`- Tool calls processed: ${totalCalls}`);
  lines.push(`- Classified calls: ${classifiedCalls}`);
  lines.push(`- Unclassified calls: ${unclassifiedCalls}`);
  lines.push(`- Generated at: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Category Totals');
  lines.push('');
  for (const category of CATEGORY_KEYS) {
    lines.push(`- ${category}: ${categoryTotals[category]}`);
  }
  lines.push('');
  lines.push('## Per-Tool Summary');
  lines.push('');
  const categoryHeader = CATEGORY_KEYS.map((key) => titleCase(key)).join(' | ');
  lines.push(`| Tool | Total | ${categoryHeader} |`);
  lines.push(`| --- | ---: | ${CATEGORY_KEYS.map(() => '---:').join(' | ')} |`);
  for (const [name, info] of summaries) {
    const counts = CATEGORY_KEYS.map((key) => info.categories[key]);
    lines.push(`| ${name} | ${info.total} | ${counts.join(' | ')} |`);
  }
  lines.push('');
  for (const [name, info] of summaries) {
    lines.push(`### ${name} (total ${info.total})`);
    const countSummary = CATEGORY_KEYS.map((key) => `${key}: ${info.categories[key]}`).join(', ');
    lines.push(`Counts → ${countSummary}`);
    for (const category of CATEGORY_KEYS) {
      const examples = info.examples[category];
      if (!examples.length) {
        continue;
      }
      lines.push(`- ${category} examples:`);
      for (const example of examples) {
        lines.push(
          `  - ${example.file}: \`${sanitizeSnippet(example.snippet)}\``
        );
      }
    }
    lines.push('');
  }
  return lines;
}

main().catch((err) => {
  console.error('[tool-classification-report] failed', err);
  process.exit(1);
});
