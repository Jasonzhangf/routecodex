#!/usr/bin/env node
// Compare inbound vs outbound Responses SSE frames field-by-field.
// Usage:
//   node scripts/compare-responses-sse.mjs --inbound <file> --outbound <file> [--ignore sequence_number,timestamp] [--limit 20]

import fs from 'node:fs';
import path from 'node:path';

function usage() {
  console.log(`Usage:
  node scripts/compare-responses-sse.mjs --inbound <file> --outbound <file> [--ignore fields] [--limit N]

Options:
  --inbound   Path to inbound SSE log (frames separated by blank lines).
  --outbound  Path to outbound SSE log (frames separated by blank lines).
  --ignore    Comma-separated field names to ignore (default: sequence_number).
  --limit     Max mismatches to print (default: 20).
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { ignore: new Set(['sequence_number']), limit: 20 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--inbound') opts.inbound = args[++i];
    else if (arg === '--outbound') opts.outbound = args[++i];
    else if (arg === '--ignore') {
      const raw = (args[++i] || '').trim();
      opts.ignore = new Set(raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : []);
    } else if (arg === '--limit') {
      opts.limit = Number(args[++i] || 20);
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${arg}`);
      usage();
      process.exit(1);
    }
  }
  if (!opts.inbound || !opts.outbound) {
    usage();
    process.exit(1);
  }
  return opts;
}

function readFile(file) {
  return fs.readFileSync(path.resolve(file), 'utf8');
}

function extractRawSse(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) {
    return text;
  }
  try {
    const data = JSON.parse(trimmed);
    const raw =
      data?.body?.raw ??
      data?.data?.raw ??
      data?.raw ??
      data?.payload?.raw ??
      data?.body?.payload?.raw;
    if (typeof raw === 'string') {
      return raw;
    }
  } catch {
    // fall through to raw text
  }
  return text;
}

function splitFrames(text) {
  if (text.includes('\n\n')) {
    return text
      .split(/\n\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // Fallback: some captures omit blank lines; split on repeated "event:" headers.
  const lines = text.split('\n');
  const frames = [];
  let current = [];
  for (const line of lines) {
    if (line.startsWith('event:') && current.length) {
      frames.push(current.join('\n').trim());
      current = [];
    }
    if (line.trim().length === 0) {
      continue;
    }
    current.push(line);
  }
  if (current.length) {
    frames.push(current.join('\n').trim());
  }
  return frames.filter(Boolean);
}

function parseFrame(frame, index) {
  const lines = frame.split('\n');
  let event = null;
  let dataLines = [];
  let id = null;
  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    } else if (line.startsWith('id:')) {
      id = line.slice(3).trim();
    }
  }
  const dataRaw = dataLines.join('\n');
  let data;
  if (dataRaw === '[DONE]') {
    data = '[DONE]';
  } else {
    try {
      data = dataRaw ? JSON.parse(dataRaw) : null;
    } catch {
      data = dataRaw;
    }
  }
  return { index, event, data, id, raw: frame };
}

function parseSseFile(file) {
  const rawText = extractRawSse(readFile(file));
  const frames = splitFrames(rawText);
  return frames.map((frame, index) => parseFrame(frame, index));
}

function eventKey(ev) {
  const data = ev.data || {};
  if (data && typeof data === 'object') {
    if (data.item && typeof data.item === 'object') {
      if (data.item.id) return `item:${data.item.id}`;
      if (data.item.call_id) return `call:${data.item.call_id}`;
    }
    if (data.item_id) return `item_id:${data.item_id}`;
    if (data.call_id) return `call:${data.call_id}`;
    if (data.response && data.response.id) return `resp:${data.response.id}`;
    if (data.output_index !== undefined) return `out:${data.output_index}`;
    if (data.summary_index !== undefined) return `summary:${data.summary_index}`;
    if (data.content_index !== undefined) return `content:${data.content_index}`;
  }
  return `idx:${ev.index}`;
}

function normalizeIgnore(ignoreSet) {
  return new Set([...ignoreSet].filter(Boolean));
}

function diffValues(a, b, ignoreSet, path = '$', diffs = []) {
  if (ignoreSet.has(path.split('.').slice(-1)[0])) {
    return diffs;
  }
  if (a === b) return diffs;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      diffs.push({ path, a, b, reason: 'array-length' });
    }
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      diffValues(a[i], b[i], ignoreSet, `${path}[${i}]`, diffs);
    }
    return diffs;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const nextPath = `${path}.${key}`;
      if (ignoreSet.has(key)) {
        continue;
      }
      diffValues(a[key], b[key], ignoreSet, nextPath, diffs);
    }
    return diffs;
  }
  diffs.push({ path, a, b, reason: 'value' });
  return diffs;
}

function groupEvents(events) {
  const map = new Map();
  for (const ev of events) {
    const key = `${ev.event || 'unknown'}|${eventKey(ev)}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ev);
  }
  return map;
}

function compare(inbound, outbound, ignoreSet, limit) {
  const inboundMap = groupEvents(inbound);
  const outboundMap = groupEvents(outbound);
  const mismatches = [];
  const missingOutbound = [];

  for (const [key, inEvents] of inboundMap.entries()) {
    const outEvents = outboundMap.get(key) || [];
    const count = Math.max(inEvents.length, outEvents.length);
    for (let i = 0; i < count; i++) {
      const inEv = inEvents[i];
      const outEv = outEvents[i];
      if (!outEv) {
        missingOutbound.push({ key, inEv });
        continue;
      }
      const diffs = diffValues(inEv.data, outEv.data, ignoreSet);
      if (diffs.length) {
        mismatches.push({ key, inEv, outEv, diffs });
      }
    }
    outboundMap.delete(key);
  }

  const extraOutbound = [];
  for (const [key, outEvents] of outboundMap.entries()) {
    for (const outEv of outEvents) {
      extraOutbound.push({ key, outEv });
    }
  }

  console.log('Summary');
  console.log(`- inbound events: ${inbound.length}`);
  console.log(`- outbound events: ${outbound.length}`);
  console.log(`- missing outbound: ${missingOutbound.length}`);
  console.log(`- extra outbound: ${extraOutbound.length}`);
  console.log(`- mismatches: ${mismatches.length}`);

  if (missingOutbound.length) {
    console.log('\nMissing outbound (first few):');
    for (const m of missingOutbound.slice(0, limit)) {
      console.log(`- ${m.key}`);
    }
  }

  if (extraOutbound.length) {
    console.log('\nExtra outbound (first few):');
    for (const m of extraOutbound.slice(0, limit)) {
      console.log(`- ${m.key}`);
    }
  }

  if (mismatches.length) {
    console.log('\nField mismatches (first few):');
    for (const m of mismatches.slice(0, limit)) {
      console.log(`- ${m.key}`);
      for (const diff of m.diffs.slice(0, limit)) {
        console.log(`  ${diff.path}: ${JSON.stringify(diff.a)} !== ${JSON.stringify(diff.b)}`);
      }
    }
  }
}

function main() {
  const opts = parseArgs();
  const inbound = parseSseFile(opts.inbound);
  const outbound = parseSseFile(opts.outbound);
  compare(inbound, outbound, normalizeIgnore(opts.ignore), opts.limit);
}

main();
