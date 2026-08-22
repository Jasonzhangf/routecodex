#!/usr/bin/env node
// Analyze latest Chat provider-request.json for GLM: detect risky fields and message anomalies.
import fs from 'fs';
import path from 'path';
import os from 'os';

function readJson(p) { try { return JSON.parse(fs.readFileSync(p,'utf-8')); } catch { return null; } }
function list(dir) { try { return fs.readdirSync(dir); } catch { return []; } }

function isNonAscii(s) { for (let i=0;i<s.length;i++){ if (s.charCodeAt(i) > 127) return true; } return false; }
function hasControl(s) { return /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(s); }

function analyzeMessages(msgs) {
  const counts = { system:0,user:0,assistant:0,tool:0,other:0 };
  for (const m of msgs) {
    const r = String(m?.role||'').toLowerCase();
    if (counts.hasOwnProperty(r)) counts[r]++; else counts.other++;
  }
  const last = msgs[msgs.length-1] || null;
  const lastRole = last ? String(last.role||'').toLowerCase() : null;
  let lastStats = null;
  if (last) {
    if (typeof last.content === 'string') {
      lastStats = {
        kind: 'string',
        length: last.content.length,
        nonAscii: isNonAscii(last.content),
        controlChars: hasControl(last.content),
        snippet: last.content.slice(0,120)
      };
    } else if (last.content == null) {
      lastStats = { kind:'null' };
    } else if (Array.isArray(last.content)) {
      lastStats = { kind:'array', length: last.content.length };
    } else {
      lastStats = { kind: typeof last.content };
    }
  }
  const assistants = msgs.filter(m=>m && m.role==='assistant');
  const asstWithTools = assistants.filter(m=>Array.isArray(m.tool_calls)&&m.tool_calls.length>0);
  return { counts, lastRole, lastStats, assistantToolCalls: asstWithTools.length };
}

function analyzeTools(tools){
  const out = { total: Array.isArray(tools)?tools.length:0, hasStrict:false, names:[] };
  if (!Array.isArray(tools)) return out;
  for (const t of tools){
    const n = t?.function?.name; if (typeof n==='string') out.names.push(n);
    if (t?.function && Object.prototype.hasOwnProperty.call(t.function,'strict')) out.hasStrict=true;
  }
  return out;
}

function findLatest(dir, suffix){
  const entries = list(dir).filter(n=>n.endsWith(suffix)).map(n=>({ n, m: fs.statSync(path.join(dir,n)).mtimeMs }));
  entries.sort((a,b)=>b.m-a.m); return entries.length?path.join(dir,entries[0].n):null;
}

(function main(){
  const base = path.join(os.homedir(),'.routecodex','codex-samples','openai-chat');
  const reqFile = findLatest(base,'_provider-request.json');
  if (!reqFile) { console.log(JSON.stringify({ ok:false, reason:'no_provider_request' })); return; }
  const req = readJson(reqFile);
  if (!req) { console.log(JSON.stringify({ ok:false, reason:'parse_failed', file:reqFile })); return; }
  const model = req.model || null;
  const messages = Array.isArray(req.messages)?req.messages:[];
  const tools = Array.isArray(req.tools)?req.tools:[];
  const msgStats = analyzeMessages(messages);
  const toolStats = analyzeTools(tools);
  console.log(JSON.stringify({ ok:true, file:reqFile, model, messageCount:messages.length, msgStats, toolStats }, null, 2));
})();

