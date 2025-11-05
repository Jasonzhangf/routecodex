#!/usr/bin/env node
// Prepare a GLM Chat Completions body from a recorded provider-request, with optional trimming and heredoc->apply_patch conversion.

import fs from 'node:fs';
import path from 'node:path';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { file: null, lastN: 30, convertHeredoc: false };
  for (const a of args) {
    if (a.startsWith('--lastN=')) opts.lastN = Math.max(1, Number(a.slice(8)) || 30);
    else if (a === '--convert-heredoc') opts.convertHeredoc = true;
    else if (!opts.file) opts.file = a;
  }
  if (!opts.file) {
    console.error('Usage: prepare-glm-body.mjs <provider-request.json> [--lastN=30] [--convert-heredoc]');
    process.exit(2);
  }
  return opts;
}

function toJsonString(v) { try { return typeof v==='string'? v: JSON.stringify(v??{});} catch { return '{}'; } }

function convertHeredocToPatch(cmd) {
  // Look for: cat > <file> << 'EOF' ... EOF
  const m = /cat\s+>\s+([^\s]+)\s+<<\s*'EOF'\n([\s\S]*?)\nEOF/.exec(cmd);
  if (!m) return null;
  const filePath = m[1];
  const content = m[2] || '';
  const lines = content.split(/\r?\n/).map(s => '+' + s).join('\n');
  const patch = `*** Begin Patch\n*** Add File: ${filePath}\n${lines}\n*** End Patch`;
  return patch;
}

function maybeConvertToolCall(tc) {
  try {
    const fn = tc.function || {};
    const name = String(fn.name||'');
    if (name !== 'shell') return tc;
    const argv = (() => {
      try { const obj = JSON.parse(fn.arguments); return Array.isArray(obj?.command)? obj.command: []; } catch { return []; }
    })();
    const cmdStr = argv.join(' ');
    const patch = convertHeredocToPatch(cmdStr);
    if (!patch) return tc;
    return { id: tc.id, type: 'function', function: { name: 'apply_patch', arguments: toJsonString({ patch }) } };
  } catch { return tc; }
}

function run() {
  const opts = parseArgs();
  const raw = fs.readFileSync(opts.file, 'utf-8');
  const j = JSON.parse(raw);
  const body = j.body || {};
  const messages = Array.isArray(body.messages) ? body.messages.slice() : [];

  // Trim: keep system + last N messages
  const sys = messages.findIndex(m => m && m.role==='system');
  const systemMsg = sys>=0? [messages[sys]]: [];
  const tail = messages.filter((_,i)=> i!==sys).slice(-opts.lastN);
  let outMsgs = systemMsg.concat(tail);

  // Normalize assistant tool_calls content and optionally convert heredoc shell to apply_patch for last tool call
  for (let i=0;i<outMsgs.length;i++) {
    const m = outMsgs[i];
    if (m && m.role==='assistant' && Array.isArray(m.tool_calls)) {
      if (m.content === '') m.content = null;
      if (opts.convertHeredoc && m.tool_calls.length>0) {
        const last = m.tool_calls[m.tool_calls.length-1];
        const conv = maybeConvertToolCall(last);
        m.tool_calls[m.tool_calls.length-1] = conv;
      }
    }
  }

  const out = { model: body.model || 'glm-4.5-air', messages: outMsgs, tools: body.tools, stream: false };
  console.log(JSON.stringify(out, null, 2));
}

run();

