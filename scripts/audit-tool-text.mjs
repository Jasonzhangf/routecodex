#!/usr/bin/env node
/**
 * Audit script: find places where tool messages are JSONish instead of plain text.
 * Scans codex-samples:
 *  - chat-replay/raw-request_req_*.json (client input)
 *  - provider-out-openai_*.json (payload sent to provider)
 *  - responses-replay/* (optional)
 */
import fs from 'fs/promises';
import path from 'path';

const home = process.env.HOME || process.env.USERPROFILE || '';
const base = path.join(home, '.routecodex', 'codex-samples');

function looksJsonishString(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t) return false;
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { JSON.parse(t); return true; } catch { return false; }
  }
  return false;
}

async function readJsonSafe(p) {
  try { const txt = await fs.readFile(p, 'utf-8'); return JSON.parse(txt); } catch { return null; }
}

async function scanChatRaw(dir) {
  const src = path.join(dir, 'chat-replay');
  let files = [];
  try { files = (await fs.readdir(src)).filter(f => f.startsWith('raw-request_req_') && f.endsWith('.json')); } catch {}
  let total = 0, toolMsgs = 0, jsonish = 0;
  const samples = [];
  for (const f of files.slice(-200)) {
    total++;
    const obj = await readJsonSafe(path.join(src, f));
    if (!obj) continue;
    const body = obj.body || {};
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    for (const m of msgs) {
      if (m && m.role === 'tool') {
        toolMsgs++;
        const c = m.content;
        if (typeof c === 'string' && looksJsonishString(c)) {
          jsonish++;
          if (samples.length < 5) samples.push({ file: f, snippet: c.slice(0, 120) });
        }
        if (c && typeof c === 'object') {
          // object/array content → counts as jsonish too
          jsonish++;
          if (samples.length < 5) samples.push({ file: f, snippet: JSON.stringify(c).slice(0, 120) });
        }
      }
    }
  }
  return { source: 'chat-replay', total, toolMsgs, jsonish, samples };
}

async function scanProviderOut(dir) {
  let files = [];
  try { files = (await fs.readdir(dir)).filter(f => f.startsWith('provider-out-openai_') && f.endsWith('.json')); } catch {}
  let total = 0, toolMsgs = 0, jsonish = 0;
  const samples = [];
  for (const f of files.slice(-200)) {
    total++;
    const obj = await readJsonSafe(path.join(dir, f));
    if (!obj) continue;
    const msgs = Array.isArray(obj.messages) ? obj.messages : [];
    for (const m of msgs) {
      if (m && m.role === 'tool') {
        toolMsgs++;
        const c = m.content;
        if (typeof c === 'string' && looksJsonishString(c)) {
          jsonish++;
          if (samples.length < 5) samples.push({ file: f, snippet: c.slice(0, 120) });
        }
        if (c && typeof c === 'object') {
          jsonish++;
          if (samples.length < 5) samples.push({ file: f, snippet: JSON.stringify(c).slice(0, 120) });
        }
      }
    }
  }
  return { source: 'provider-out-openai', total, toolMsgs, jsonish, samples };
}

async function main() {
  console.log('# Audit tool text extraction');
  console.log('base:', base);
  const chat = await scanChatRaw(base);
  const prov = await scanProviderOut(base);
  const fmt = r => `${r.source}: files=${r.total}, toolMsgs=${r.toolMsgs}, jsonish=${r.jsonish}`;
  console.log(fmt(chat));
  console.log(fmt(prov));
  if (chat.samples.length) {
    console.log('chat-replay samples:');
    for (const s of chat.samples) console.log('-', s.file, '::', s.snippet);
  }
  if (prov.samples.length) {
    console.log('provider-out samples:');
    for (const s of prov.samples) console.log('-', s.file, '::', s.snippet);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

