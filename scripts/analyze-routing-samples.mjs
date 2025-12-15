#!/usr/bin/env node
/**
 * Analyze Codex sample requests collected under ~/.routecodex/codex-samples
 * and summarize the last assistant tool calls observed in inbound requests.
 *
 * Usage:
 *   node scripts/analyze-routing-samples.mjs [--limit N] [--root DIR] [--protocols list]
 *     --limit      Number of most recent samples to scan per protocol (default: 200)
 *     --root       Override sample root (default: ~/.routecodex/codex-samples)
 *     --protocols  Comma-separated list of protocol folders to include
 */
import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const options = {
  limit: 200,
  root: path.join(os.homedir(), '.routecodex', 'codex-samples'),
  protocols: null,
};
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--limit' && i + 1 < args.length) {
    options.limit = Number(args[i + 1]);
    i += 1;
  } else if (arg === '--root' && i + 1 < args.length) {
    options.root = path.resolve(args[i + 1]);
    i += 1;
  } else if (arg === '--protocols' && i + 1 < args.length) {
    options.protocols = args[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
    i += 1;
  }
}

const STAGE_SUFFIX = '_req_process_tool_filters_request_pre.json';

function listProtocols(dir) {
  return fs.readdir(dir, { withFileTypes: true })
    .then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name))
    .catch(() => []);
}

function listStageFiles(dir) {
  try {
    const out = execSync(`rg --files "${dir}" -g "*${STAGE_SUFFIX}"`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean);
  } catch (err) {
    if (err?.status === 1 && (!err.stdout || err.stdout.length === 0)) return [];
    throw err;
  }
}

function extractTimestamp(filePath) {
  const base = path.basename(filePath);
  const m = base.match(/req_(\d+)_/);
  if (!m) return 0;
  return Number(m[1]);
}

function extractRequestId(filePath) {
  const base = path.basename(filePath);
  const m = base.match(/^(req_\d+_[^_]+)/);
  return m ? m[1] : base;
}

function safeText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part) return '';
      if (typeof part === 'string') return part;
      if (typeof part === 'object') {
        if (typeof part.text === 'string') return part.text;
        if (Array.isArray(part.text)) return part.text.join(' ');
        if (typeof part.content === 'string') return part.content;
      }
      return '';
    }).join(' ');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return '';
}

function lastAssistantToolCalls(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== 'assistant') continue;
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : null;
    if (calls && calls.length) {
      return calls
        .map((call) => {
          const name = call?.function?.name || call?.name;
          if (!name) return null;
          const args = typeof call?.function?.arguments === 'string' ? call.function.arguments : undefined;
          return { name, arguments: args };
        })
        .filter(Boolean);
    }
  }
  return [];
}

function lastUserText(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === 'user') {
      return safeText(msg.content).slice(0, 400);
    }
  }
  return '';
}

async function main() {
  const protocols = options.protocols || await listProtocols(options.root);
  const perProtocol = new Map();
  const files = [];
  for (const proto of protocols) {
    const dir = path.join(options.root, proto);
    const list = listStageFiles(dir);
    if (list.length === 0) continue;
    const sorted = list
      .map((filePath) => ({ filePath, ts: extractTimestamp(filePath) }))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, options.limit);
    perProtocol.set(proto, sorted.length);
    files.push(...sorted.map((item) => ({ ...item, proto })));
  }

  const toolCounts = new Map();
  const toolExamples = new Map();
  let withAssistantTools = 0;
  for (const { filePath, proto } of files) {
    let payload;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      payload = JSON.parse(raw);
    } catch {
      continue;
    }
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    const calls = lastAssistantToolCalls(messages);
    if (calls.length) {
      withAssistantTools += 1;
      const snippet = lastUserText(messages);
      const reqId = extractRequestId(filePath);
      for (const call of calls) {
        const canonical = canonicalizeToolName(call.name);
        const parsedArguments = parseArguments(call.arguments);
        toolCounts.set(canonical, (toolCounts.get(canonical) || 0) + 1);
        if (!toolExamples.has(canonical)) {
          toolExamples.set(canonical, []);
        }
        const collection = toolExamples.get(canonical);
        if (collection.length < 3) {
          collection.push({
            reqId,
            proto,
            snippet,
            rawName: call.name,
            command: parsedArguments?.command || parsedArguments?.input?.command
          });
        }
      }
    }
  }

  const histogram = Array.from(toolCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count, examples: toolExamples.get(name) || [] }));

  const summary = {
    sampleRoot: options.root,
    perProtocolCounts: Object.fromEntries(perProtocol),
    totalSamples: files.length,
    requestsWithAssistantTool: withAssistantTools,
    uniqueTools: histogram.length,
    toolHistogram: histogram,
  };

  console.log(JSON.stringify(summary, null, 2));
}

function canonicalizeToolName(name) {
  if (!name) return '';
  const trimmed = name.trim();
  const marker = trimmed.indexOf('arg_key');
  if (marker > 0) {
    return trimmed.slice(0, marker);
  }
  return trimmed;
}

function parseArguments(argumentString) {
  if (typeof argumentString !== 'string' || !argumentString.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(argumentString);
  } catch {
    return undefined;
  }
}

main().catch((err) => {
  console.error('Failed to analyze samples:', err);
  process.exit(1);
});
