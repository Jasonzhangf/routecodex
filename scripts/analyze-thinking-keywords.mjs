#!/usr/bin/env node
/**
 * Analyze which thinkingKeywords are actually hit in historical samples.
 *
 * - Uses current modules.virtualrouter.config.classificationConfig.thinkingKeywords
 * - Replays classification over ~/.routecodex/codex-samples
 * - For samples routed to 'thinking', counts keyword matches
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const HOME = os.homedir();
const CHAT_DIR = path.join(HOME, '.routecodex', 'codex-samples', 'openai-chat');
const RESP_DIR = path.join(HOME, '.routecodex', 'codex-samples', 'openai-responses');
const ANTH_DIR = path.join(HOME, '.routecodex', 'codex-samples', 'anthropic-messages');

function safeParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

async function listFiles(dir, pattern) {
  try {
    const all = await fs.readdir(dir);
    return all.filter(f => pattern.test(f)).map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

async function loadClassificationConfigFromModules() {
  const modulesPath = path.join(process.cwd(), 'config', 'modules.json');
  const raw = await fs.readFile(modulesPath, 'utf-8');
  const json = JSON.parse(raw);
  const cfg =
    json?.modules?.virtualrouter?.config?.classificationConfig ||
    json?.virtualrouter?.config?.classificationConfig ||
    null;
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('classificationConfig not found in config/modules.json');
  }
  return cfg;
}

function detectProtocol(endpoint, protocolMapping) {
  for (const [protocol, mapping] of Object.entries(protocolMapping)) {
    for (const ep of mapping.endpoints || []) {
      if (endpoint.includes(ep)) return protocol;
    }
  }
  return 'unknown';
}

function extractUserText(request, endpoint, protocolMapping) {
  const protocol = detectProtocol(endpoint, protocolMapping);
  const mapping = protocolMapping[protocol];
  if (!mapping) {
    return { primaryUserText: '', allUserText: '' };
  }
  const rawMessages = request[mapping.messageField];
  const msgs = Array.isArray(rawMessages) ? rawMessages : [];
  const userTexts = [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || '').toLowerCase();
    if (role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') {
      userTexts.push(c);
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          userTexts.push(part.text);
        }
      }
    }
  }
  if (!userTexts.length) return { primaryUserText: '', allUserText: '' };
  return {
    primaryUserText: userTexts[userTexts.length - 1],
    allUserText: userTexts.join('\n')
  };
}

async function main() {
  const classificationConfig = await loadClassificationConfigFromModules();
  const thinkingKeywords = (classificationConfig.thinkingKeywords || []).map((s) =>
    String(s || '').toLowerCase()
  );
  const protocolMapping = classificationConfig.protocolMapping || {};

  const distPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '..',
    'dist',
    'modules',
    'virtual-router',
    'classifiers',
    'config-request-classifier.js'
  );
  const { ConfigRequestClassifier } = await import('file://' + distPath);
  const cls = ConfigRequestClassifier.fromModuleConfig(classificationConfig);

  const chatFiles = await listFiles(CHAT_DIR, /_provider-request\.json$/);
  const respFiles = await listFiles(RESP_DIR, /_pipeline\.provider\.request\.pre\.json$/);
  const anthFiles = await listFiles(ANTH_DIR, /_pipeline\.provider\.request\.pre\.json$/);

  const all = [
    ...chatFiles.map((f) => ({ file: f, endpoint: '/v1/chat/completions', kind: 'chat' })),
    ...respFiles.map((f) => ({ file: f, endpoint: '/v1/responses', kind: 'responses' })),
    ...anthFiles.map((f) => ({ file: f, endpoint: '/v1/messages', kind: 'messages' }))
  ];

  const keywordHitCounts = new Map();
  const samplePerKeyword = new Map();
  let thinkingCount = 0;

  for (const item of all) {
    const raw = await fs.readFile(item.file, 'utf-8');
    const j = safeParse(raw);
    if (!j) continue;
    let body = null;
    if (item.kind === 'chat') {
      body = j?.data?.body || null;
    } else {
      body = j?.data?.payload || null;
    }
    if (!body) continue;

    const res = await cls.classify({ request: body, endpoint: item.endpoint });
    if (!res || !res.success || res.route !== 'thinking') continue;
    thinkingCount++;

    const { primaryUserText, allUserText } = extractUserText(
      body,
      item.endpoint,
      protocolMapping
    );
    const source = (primaryUserText + '\n' + allUserText).toLowerCase();
    for (const kw of thinkingKeywords) {
      if (!kw) continue;
      if (source.includes(kw)) {
        keywordHitCounts.set(kw, (keywordHitCounts.get(kw) || 0) + 1);
        if (!samplePerKeyword.has(kw)) {
          samplePerKeyword.set(kw, item.file);
        }
      }
    }
  }

  const report = {
    thinkingSamples: thinkingCount,
    keywordHits: Object.fromEntries(keywordHitCounts.entries()),
    samplePerKeyword: Object.fromEntries(samplePerKeyword.entries())
  };

  const outDir = path.join(process.cwd(), 'docs', 'reports');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'thinking-keywords-report.json');
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log('Thinking keywords report written to:', outPath);
}

main().catch((err) => {
  console.error('analyze-thinking-keywords failed:', err);
  process.exit(1);
});

