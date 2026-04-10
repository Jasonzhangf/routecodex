#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const PROVIDER_BASE = process.env.ROUTECODEX_PROVIDER_BASE || path.join(os.homedir(), '.routecodex', 'provider');
const ENTRY_ENDPOINTS = [
  {
    endpoint: '/v1/chat/completions',
    requestInbound: 'chat-input',
    responseOutbound: 'openai-output',
    clientProtocol: 'openai-chat',
    clientStreamPolicy: 'mirror',
    providerStream: false
  },
  {
    endpoint: '/v1/responses',
    requestInbound: 'responses-input',
    responseOutbound: 'responses-output',
    clientProtocol: 'openai-responses',
    clientStreamPolicy: 'responses-sse',
    providerStream: true
  },
  {
    endpoint: '/v1/messages',
    requestInbound: 'anthropic-input',
    responseOutbound: 'anthropic-output',
    clientProtocol: 'anthropic-messages',
    clientStreamPolicy: 'mirror',
    providerStream: false
  }
];

const PROVIDER_RULES = {
  openai: {
    requestOutbound: 'openai-output',
    responseInbound: 'openai-response-input'
  },
  responses: {
    requestOutbound: 'responses-output',
    responseInbound: 'responses-response-input'
  },
  anthropic: {
    requestOutbound: 'anthropic-output',
    responseInbound: 'anthropic-response-input'
  },
  gemini: {
    requestOutbound: 'gemini-output',
    responseInbound: 'gemini-response-input'
  },
  lmstudio: {
    requestOutbound: 'openai-output',
    responseInbound: 'openai-response-input'
  }
};

async function loadConfig(dir) {
  const files = await fs.readdir(dir);
  const merged = files.filter(name => name.startsWith('merged-config') && name.endsWith('.json')).sort();
  const candidate = merged.at(-1) || 'config.json';
  const full = path.join(dir, candidate);
  try {
    const raw = await fs.readFile(full, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeProviders(vr) {
  const providers = vr?.providers || {};
  const out = [];
  for (const [id, info] of Object.entries(providers)) {
    const type = String(info?.type || info?.providerType || 'openai').toLowerCase();
    const models = info?.models ? Object.keys(info.models) : [];
    out.push({ id, type, models });
  }
  return out;
}

function buildPath(entry, provider) {
  const entryRule = ENTRY_ENDPOINTS.find(e => e.endpoint === entry);
  if (!entryRule) return null;
  const provRule = PROVIDER_RULES[provider.type] || PROVIDER_RULES.openai;
  return {
    entryEndpoint: entryRule.endpoint,
    clientProtocol: entryRule.clientProtocol,
    request: {
      inbound: entryRule.requestInbound,
      outbound: provRule.requestOutbound
    },
    response: {
      inbound: provRule.responseInbound,
      outbound: entryRule.responseOutbound
    },
    streaming: {
      client: entryRule.clientStreamPolicy,
      provider: provider.type === 'responses' ? true : entryRule.providerStream
    }
  };
}

async function main() {
  const entries = await fs.readdir(PROVIDER_BASE, { withFileTypes: true });
  const matrix = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(PROVIDER_BASE, entry.name);
    const cfg = await loadConfig(dir);
    if (!cfg) continue;
    const vr = cfg.virtualrouter || cfg;
    if (!vr?.providers) continue;
    const providers = normalizeProviders(vr);
    for (const provider of providers) {
      for (const endpoint of ENTRY_ENDPOINTS) {
        const pathInfo = buildPath(endpoint.endpoint, provider);
        if (!pathInfo) continue;
        matrix.push({
          providerRoot: entry.name,
          providerId: provider.id,
          providerType: provider.type,
          models: provider.models,
          ...pathInfo
        });
      }
    }
  }
  console.log(JSON.stringify(matrix, null, 2));
}

main().catch(err => {
  console.error('[inspect-provider-paths] failed:', err);
  process.exit(1);
});
