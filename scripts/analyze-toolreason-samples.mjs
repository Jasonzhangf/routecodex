#!/usr/bin/env node
/**
 * Machine summary for live toolreason samples.
 *
 * This is deliberately read-only. It counts provider tool-call turns and
 * raw toolreason markers from the canonical ~/.rcc sample tree; it never
 * infers OK/MISSING from a single log line. Pass --observations when a
 * captured TOOLREASON console stream is available.
 *
 * Usage:
 *   node scripts/analyze-toolreason-samples.mjs --port 7777 --limit 200
 *   node scripts/analyze-toolreason-samples.mjs --json
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const options = {
  root: path.join(os.homedir(), '.rcc', 'codex-samples'),
  protocol: 'openai-responses',
  port: null,
  limit: 200,
  observations: null,
  json: false,
};
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--root') options.root = path.resolve(argv[++i]);
  else if (arg === '--protocol') options.protocol = argv[++i];
  else if (arg === '--port') options.port = argv[++i];
  else if (arg === '--limit') options.limit = Number(argv[++i]);
  else if (arg === '--observations') options.observations = path.resolve(argv[++i]);
  else if (arg === '--json') options.json = true;
}

async function directories(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

function walk(value, visit) {
  visit(value);
  if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => walk(item, visit));
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value).map(([key, item]) => `${key}:${textOf(item)}`).join(' ');
}

function countToolCalls(value) {
  let count = 0;
  walk(value, (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    if (item.type === 'tool_use' || item.type === 'function_call' || item.type === 'custom_tool_call') count += 1;
    if (Array.isArray(item.tool_calls)) count += item.tool_calls.length;
  });
  if (count > 0) return count;
  const raw = textOf(value);
  return (raw.match(/content_block_start[^\n]*tool_use|response\.output_item\.added[^\n]*(?:function_call|custom_tool_call)/g) || []).length;
}

function promptLocations(request) {
  const found = { instructions: 0, system: 0, developer: 0, tool_description: 0 };
  walk(request, (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const marker = Object.values(item).some((value) => typeof value === 'string' && value.includes('工具调用时必须先输出原因标签'));
    if (!marker) return;
    if (typeof item.instructions === 'string') found.instructions += 1;
    if (item.role === 'system') found.system += 1;
    if (item.role === 'developer') found.developer += 1;
    if (typeof item.description === 'string') found.tool_description += 1;
  });
  return found;
}

function observeFile(file) {
  return fs.readFile(file, 'utf8').then((raw) => {
    const rows = raw.split(/\r?\n/).filter(Boolean);
    return {
      ok: rows.filter((row) => /TOOLREASON OK\b/.test(row)).length,
      missing: rows.filter((row) => /TOOLREASON MISSING\b/.test(row)).length,
      lines: rows.length,
    };
  }).catch(() => ({ ok: 0, missing: 0, lines: 0 }));
}

async function main() {
  const portRoot = path.join(options.root, options.protocol, 'ports');
  const ports = options.port ? [path.join(portRoot, options.port)] : await directories(portRoot);
  const samples = [];
  for (const port of ports) {
    for (const sample of await directories(port)) {
      const stat = await fs.stat(sample).catch(() => null);
      if (stat) samples.push({ sample, mtime: stat.mtimeMs, port: path.basename(port) });
    }
  }
  samples.sort((a, b) => b.mtime - a.mtime);
  const selected = samples.slice(0, options.limit);
  const result = {
    root: options.root,
    protocol: options.protocol,
    ports: [...new Set(selected.map((item) => item.port))],
    scanned_samples: selected.length,
    tool_call_samples: 0,
    tool_call_turns_estimate: 0,
    raw_toolreason_samples: 0,
    raw_toolreason_tags: 0,
    prompt_locations: { instructions: 0, system: 0, developer: 0, tool_description: 0 },
    status_counts: {},
    mapping_errors: 0,
    observation_logs: null,
    acceptance: { ok_plus_missing_equals_tool_call_turns: null, source: 'provider samples alone cannot prove runtime OK/MISSING coverage' },
    examples: [],
  };
  for (const item of selected) {
    const request = await readJson(path.join(item.sample, 'provider-request.json'));
    const response = await readJson(path.join(item.sample, 'provider-response.json'));
    const error = await readJson(path.join(item.sample, 'error.json'));
    const calls = countToolCalls(response);
    const responseText = textOf(response);
    const tags = (responseText.match(/<toolreason>/g) || []).length + (responseText.match(/<\/toolreason>/g) || []).length;
    const locations = promptLocations(request);
    const hasStatus = error?.status ?? response?.status ?? response?.responseStatus;
    if (calls > 0) {
      result.tool_call_samples += 1;
      result.tool_call_turns_estimate += 1;
      if (result.examples.length < 5) result.examples.push({ sample: path.basename(item.sample), calls, tags, locations });
    }
    if (tags > 0) { result.raw_toolreason_samples += 1; result.raw_toolreason_tags += tags; }
    Object.entries(locations).forEach(([key, value]) => { result.prompt_locations[key] += value; });
    if (hasStatus !== undefined && hasStatus !== null) {
      const key = String(hasStatus);
      result.status_counts[key] = (result.status_counts[key] || 0) + 1;
      if (key === '400' || key === '502') result.mapping_errors += 1;
    }
  }
  if (options.observations) {
    result.observation_logs = await observeFile(options.observations);
    result.acceptance = {
      ok_plus_missing_equals_tool_call_turns:
        result.observation_logs.ok + result.observation_logs.missing === result.tool_call_turns_estimate,
      source: 'provider sample estimate + supplied TOOLREASON log',
    };
  }
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`toolreason samples: ${result.scanned_samples}`);
    console.log(`tool-call turns (estimate): ${result.tool_call_turns_estimate}`);
    console.log(`raw toolreason tags: ${result.raw_toolreason_tags}`);
    console.log(`prompt locations: ${JSON.stringify(result.prompt_locations)}`);
    console.log(`400/502 samples: ${result.mapping_errors}`);
    console.log(`OK/MISSING coverage: ${result.acceptance.ok_plus_missing_equals_tool_call_turns ?? 'not measurable without --observations'}`);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
