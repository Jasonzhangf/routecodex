#!/usr/bin/env node
// iFlow test script with OAuth token lifecycle management + optional tool SSE loop
// Examples:
//  - Ensure token then proxy chat: RC_BASE=http://127.0.0.1:5506 node scripts/test-iflow.mjs --mode=proxy --endpoint=/v1/chat/completions
//  - Ensure token then upstream chat: IFLOW_CLIENT_ID=... node scripts/test-iflow.mjs --mode=upstream
//  - Responses tool loop (one-shot delta): RC_BASE=http://127.0.0.1:5506 node scripts/test-iflow.mjs --mode=proxy --endpoint=/v1/responses --tools

import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

/**
 * Options via env/args
 *  - MODE: proxy | upstream (default: proxy)
 *  - RC_BASE: default http://127.0.0.1:5506
 *  - RC_ENDPOINT: default /v1/chat/completions (also supports /v1/responses)
 *  - IFLOW_MODEL: default gpt-4o-mini
 *  - TEXT: default "hello from RouteCodex test"
 *  - CONFIG: RouteCodex user config path (default ~/.routecodex/config/v2/iflow-only.json)
 *  - tools: flag to run /v1/responses SSE tool loop
 */

const args = Object.fromEntries(process.argv.slice(2).map(kv => {
  const m = kv.match(/^--([^=]+)=(.*)$/);
  if (m) return [m[1], m[2]];
  if (kv.startsWith('--')) return [kv.slice(2), true];
  return [kv, true];
}));

const MODE = String(args.mode || process.env.MODE || 'proxy');
const RC_BASE = String(process.env.RC_BASE || 'http://127.0.0.1:5506').replace(/\/$/, '');
const RC_ENDPOINT = String(args.endpoint || process.env.RC_ENDPOINT || '/v1/chat/completions');
// 默认模型更新为 iFlow-ROME-30BA3B，除非通过 IFLOW_MODEL 显式覆盖。
const IFLOW_MODEL = String(process.env.IFLOW_MODEL || 'iFlow-ROME-30BA3B');
const TEXT = String(process.env.TEXT || 'hello from RouteCodex test');
const RUN_TOOLS = !!args.tools;
const CONFIG_PATH = expandHome(String(process.env.CONFIG || args.config || path.join(os.homedir(), '.routecodex', 'config', 'v2', 'iflow-only.json')));

function expandHome(p) { return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p; }

async function loadIFlowOAuthConfig(configPath) {
  const raw = await fsp.readFile(configPath, 'utf-8');
  const j = JSON.parse(raw);
  const prov = j?.virtualrouter?.providers?.iflow;
  if (!prov) throw new Error('iflow provider not found in config');
  const oauth = prov?.oauth?.default || {};
  return {
    clientId: process.env.IFLOW_CLIENT_ID || oauth.clientId,
    deviceCodeUrl: process.env.IFLOW_DEVICE_CODE_URL || oauth.deviceCodeUrl || oauth.device_code_url,
    tokenUrl: process.env.IFLOW_TOKEN_URL || oauth.tokenUrl,
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes : (typeof oauth.scope === 'string' ? oauth.scope.split(/[\s,]+/).filter(Boolean) : ['inference']),
    tokenFile: expandHome(oauth.tokenFile || path.join(os.homedir(), '.routecodex', 'tokens', 'iflow-default.json')),
    apiBase: prov?.baseURL || 'https://api.iflow.cn/v1'
  };
}

async function readToken(file) {
  try { const txt = await fsp.readFile(file, 'utf-8'); return JSON.parse(txt); } catch { return null; }
}

async function saveToken(file, tok) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const withIssued = { ...tok };
  if (!withIssued.issued_at) withIssued.issued_at = Math.floor(Date.now()/1000);
  await fsp.writeFile(file, JSON.stringify(withIssued, null, 2), 'utf-8');
}

function isExpired(tok, skewSec = 60) {
  const now = Math.floor(Date.now()/1000);
  const issued = Number(tok.issued_at || 0);
  const expAt = tok.expires_at ? Number(tok.expires_at) : (tok.expires_in ? issued + Number(tok.expires_in) : 0);
  if (!expAt) return false; // if unknown, assume valid
  return now >= (expAt - skewSec);
}

async function refreshToken(oauth, tok) {
  if (!tok?.refresh_token) throw new Error('No refresh_token to refresh');
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('client_id', oauth.clientId);
  body.set('refresh_token', tok.refresh_token);
  if (process.env.IFLOW_CLIENT_SECRET) body.set('client_secret', process.env.IFLOW_CLIENT_SECRET);
  const res = await fetch(oauth.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`refresh failed ${res.status}: ${text}`);
  const j = JSON.parse(text);
  const merged = { ...tok, ...j, issued_at: Math.floor(Date.now()/1000) };
  if (j.expires_in && !j.expires_at) merged.expires_at = merged.issued_at + Number(j.expires_in);
  return merged;
}

async function openBrowser(url) {
  try {
    const platform = process.platform;
    if (platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    else if (platform === 'win32') spawn('cmd', ['/c', 'start', '""', url]);
    else spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch { /* ignore */ }
}

async function deviceCodeFlow(oauth) {
  const body = new URLSearchParams();
  body.set('client_id', oauth.clientId);
  if (oauth.scopes?.length) body.set('scope', oauth.scopes.join(' '));
  const res = await fetch(oauth.deviceCodeUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const txt = await res.text();
  if (!res.ok) throw new Error(`device code request failed ${res.status}: ${txt}`);
  const dc = JSON.parse(txt);
  const verifyUrl = dc.verification_uri_complete || dc.verification_uri;
  console.log(`Open this URL to authorize:
  ${verifyUrl}
  code: ${dc.user_code || '(auto)'}`);
  if (verifyUrl) await openBrowser(verifyUrl);
  const intervalMs = Math.max(5, Number(dc.interval || 5)) * 1000;
  const deadline = Date.now() + (Number(dc.expires_in || 600) * 1000);
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    const poll = new URLSearchParams();
    poll.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');
    poll.set('device_code', dc.device_code);
    poll.set('client_id', oauth.clientId);
    if (process.env.IFLOW_CLIENT_SECRET) poll.set('client_secret', process.env.IFLOW_CLIENT_SECRET);
    const pr = await fetch(oauth.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: poll });
    const ptxt = await pr.text();
    if (pr.status === 200) {
      const tok = JSON.parse(ptxt);
      tok.issued_at = Math.floor(Date.now()/1000);
      if (tok.expires_in && !tok.expires_at) tok.expires_at = tok.issued_at + Number(tok.expires_in);
      return tok;
    }
    try {
      const j = JSON.parse(ptxt);
      const err = j.error || '';
      if (err === 'authorization_pending') continue;
      if (err === 'slow_down') { await new Promise(r => setTimeout(r, 5000)); continue; }
      throw new Error(`device flow error: ${ptxt}`);
    } catch {
      throw new Error(`device flow error: ${ptxt}`);
    }
  }
  throw new Error('device code expired');
}

async function ensureToken(oauth) {
  let tok = await readToken(oauth.tokenFile);
  if (tok && !isExpired(tok)) return tok;
  if (tok && tok.refresh_token) {
    try {
      console.log('[iflow] refreshing token...');
      tok = await refreshToken(oauth, tok);
      await saveToken(oauth.tokenFile, tok);
      return tok;
    } catch (e) {
      console.warn(`[iflow] refresh failed: ${e?.message || e}`);
    }
  }
  console.log('[iflow] starting device-code flow to obtain new token...');
  const newTok = await deviceCodeFlow(oauth);
  await saveToken(oauth.tokenFile, newTok);
  return newTok;
}

async function requestUpstreamChat(oauth, token) {
  const url = `${oauth.apiBase.replace(/\/$/, '')}/chat/completions`;
  const payload = { model: IFLOW_MODEL, messages: [{ role: 'user', content: TEXT }], stream: false };
  const res = await fetch(url, { method: 'POST', headers: { 'Authorization': `Bearer ${token.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await res.text();
  console.log(`[UPSTREAM] status=${res.status}`);
  try { console.log(JSON.stringify(JSON.parse(body), null, 2)); } catch { console.log(body); }
}

async function requestUpstreamWebSearch(oauth, token) {
  const url = `${oauth.apiBase.replace(/\/$/, '')}/chat/completions`;
  const payload = {
    model: IFLOW_MODEL,
    messages: [
      {
        role: 'system',
        content: 'You are an up-to-date web search engine. Call the web_search tool to fetch current results, then answer based on the tool output.'
      },
      {
        role: 'user',
        content: `${TEXT}. 请先调用 web_search 工具检索相关信息，再根据搜索结果回答。`
      }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Perform web search over the public internet and return up-to-date results.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query string.'
              },
              recency: {
                type: 'string',
                description: 'Optional recency filter such as "day", "week", or "month".'
              },
              count: {
                type: 'integer',
                minimum: 1,
                maximum: 50,
                description: 'Maximum number of search results to retrieve (1-50).'
              }
            },
            required: ['query']
          }
        }
      }
    ],
    tool_choice: {
      type: 'function',
      function: {
        name: 'web_search'
      }
    },
    stream: false
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token.access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  console.log(`[UPSTREAM][web_search] status=${res.status}`);
  let json = null;
  try {
    json = JSON.parse(text);
    console.log(JSON.stringify(json, null, 2));
  } catch {
    console.log(text);
    throw new Error('iflow web_search returned non-JSON payload');
  }
  if (!res.ok) {
    throw new Error(`iflow web_search failed: HTTP ${res.status}`);
  }
  const firstChoice = Array.isArray(json.choices) ? json.choices[0] : null;
  const msg = firstChoice?.message || {};
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  console.log(`[UPSTREAM][web_search] tool_calls=${toolCalls.length}`);
  if (!toolCalls.length) {
    console.warn('[UPSTREAM][web_search] no tool_calls returned, web_search tool may not be enabled for this model.');
  } else {
    const names = toolCalls
      .map((tc) => (tc && tc.function && typeof tc.function.name === 'string' ? tc.function.name : ''))
      .filter(Boolean);
    console.log(`[UPSTREAM][web_search] tool names: ${names.join(', ')}`);
  }
}

async function requestProxyChat() {
  const url = `${RC_BASE}${RC_ENDPOINT}`;
  const payload = { model: IFLOW_MODEL, messages: [{ role: 'user', content: TEXT }], stream: false };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await res.text();
  console.log(`[PROXY] ${url} status=${res.status}`);
  try { console.log(JSON.stringify(JSON.parse(body), null, 2)); } catch { console.log(body); }
}

async function runResponsesToolLoop() {
  const url = `${RC_BASE}/v1/responses`;
  const payload = {
    model: IFLOW_MODEL,
    input: [ { type: 'text', text: `${TEXT}. 请使用可用的工具完成任务。` } ],
    stream: true
  };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' }, body: JSON.stringify(payload) });
  if (!res.ok || !res.body) { console.error(`[RESPONSES] HTTP ${res.status}`); console.log(await res.text()); return; }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let responseId = '';
  let required = null;
  console.log('[RESPONSES] streaming...');
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split(/\n\n/);
    buf = chunks.pop() || '';
    for (const chunk of chunks) {
      const lines = chunk.split(/\n/);
      let ev = '';
      let data = '';
      for (const ln of lines) {
        if (ln.startsWith('event:')) ev = ln.slice(6).trim();
        if (ln.startsWith('data:')) data += ln.slice(5).trim();
      }
      if (!data) continue;
      try {
        const j = JSON.parse(data);
        if (j?.response?.id && !responseId) responseId = j.response.id;
        if (ev === 'response.required_action' || (j?.type === 'response.required_action')) {
          required = j;
        }
        if (ev === 'response.done' || j?.type === 'response.done') {
          console.log('[RESPONSES] done');
        }
      } catch { /* ignore */ }
    }
    if (required && responseId) break; // got required_action
  }
  if (!required || !responseId) { console.warn('[RESPONSES] no required_action found'); return; }
  const toolCalls = required?.response?.required_action?.submit_tool_outputs?.tool_calls || [];
  console.log(`[RESPONSES] tool_calls: ${toolCalls.length}`);
  const outputs = toolCalls.map(tc => ({ tool_call_id: tc?.id || tc?.tool_call_id || '', output: 'ok' }));
  const contUrl = `${RC_BASE}/v1/responses/${encodeURIComponent(responseId)}/submit_tool_outputs`;
  const contPayload = { model: IFLOW_MODEL, tool_outputs: outputs, stream: true };
  const cont = await fetch(contUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' }, body: JSON.stringify(contPayload) });
  console.log(`[RESPONSES][CONT] status=${cont.status}`);
  // Read until response.done or short timeout
  if (cont.body) {
    const reader2 = cont.body.getReader();
    const decoder2 = new TextDecoder();
    let buf2 = '';
    const until = Date.now() + 15000; // 15s max
    let finished = false;
    while (Date.now() < until) {
      const { value, done } = await reader2.read();
      if (done) break;
      buf2 += decoder2.decode(value, { stream: true });
      const parts = buf2.split(/\n\n/);
      buf2 = parts.pop() || '';
      for (const ch of parts) {
        const lines = ch.split(/\n/);
        let ev = '';
        let data = '';
        for (const ln of lines) {
          if (ln.startsWith('event:')) ev = ln.slice(6).trim();
          if (ln.startsWith('data:')) data += ln.slice(5).trim();
        }
        try {
          const jj = JSON.parse(data);
          if (ev === 'response.done' || jj?.type === 'response.done') {
            console.log('[RESPONSES][CONT] done');
            finished = true;
            break;
          }
        } catch { /* ignore */ }
      }
      if (finished) break;
    }
    try { await reader2.cancel(); } catch { /* ignore */ }
  }
}

async function main() {
  // 1) Load OAuth config & ensure token freshness before any real request
  const oauth = await loadIFlowOAuthConfig(CONFIG_PATH);
  const token = await ensureToken(oauth);

  // 2) Perform requested action
  if (MODE === 'upstream') {
    await requestUpstreamChat(oauth, token);
    return;
  }
  if (MODE === 'websearch') {
    await requestUpstreamWebSearch(oauth, token);
    return;
  }
  if (RUN_TOOLS) {
    await requestProxyChat(); // warmup
    await runResponsesToolLoop();
    return;
  }
  await requestProxyChat();
}

main().catch(err => { console.error(err); process.exit(1); });
