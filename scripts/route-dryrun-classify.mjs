#!/usr/bin/env node
/*
 * RouteCodex - Routing Dry-Run Classifier
 * Scans ~/.routecodex/codex-samples/* requests, classifies routes, and reports hit/miss categories.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

const HOME = os.homedir();
const CHAT_DIR = path.join(HOME, '.routecodex', 'codex-samples', 'openai-chat');
const RESP_DIR = path.join(HOME, '.routecodex', 'codex-samples', 'openai-responses');
const ANTH_DIR = path.join(HOME, '.routecodex', 'codex-samples', 'anthropic-messages');

function safeParse(jsonStr) { try { return JSON.parse(jsonStr); } catch { return null; } }

async function loadClassifier() {
  // Prefer compiled dist path
  const distPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'modules', 'virtual-router', 'classifiers', 'config-request-classifier.js');
  const mod = await import('file://' + distPath);
  return mod.ConfigRequestClassifier;
}

function buildClassifierConfig() {
  // Minimal but useful config: openai mapping; toolDetector with patterns; routing decisions for key routes
  return {
    protocolMapping: {
      openai: {
        endpoints: ['/v1/chat/completions', '/v1/responses'],
        messageField: 'messages',
        modelField: 'model',
        toolsField: 'tools',
        maxTokensField: 'max_tokens'
      },
      anthropic: {
        endpoints: ['/v1/messages'],
        messageField: 'messages',
        modelField: 'model',
        toolsField: 'tools',
        maxTokensField: 'max_tokens'
      }
    },
    protocolHandlers: {
      openai: {
        tokenCalculator: {},
        toolDetector: {
          type: 'pattern',
          patterns: {
            webSearch: ['web_search', 'search', 'bing', 'google'],
            codeExecution: ['shell', 'bash', 'python', 'apply_patch', 'functions.shell'],
            fileSearch: ['files', 'rg', 'ripgrep', 'find', 'ls', 'tree'],
            dataAnalysis: ['sql', 'analytics', 'pandas', 'chart']
          }
        }
      },
      anthropic: {
        tokenCalculator: {},
        toolDetector: {
          type: 'pattern',
          patterns: {
            webSearch: ['web_search', 'search', 'browse'],
            codeExecution: ['code', 'execute', 'bash', 'python'],
            fileSearch: ['file', 'read', 'write'],
            dataAnalysis: ['data', 'analysis', 'chart']
          }
        }
      }
    },
    modelTiers: {
      basic: { description: 'Basic', models: ['gpt-oss-20b-mlx', 'glm-4.6'], maxTokens: 8192, supportedFeatures: [] },
      advanced: { description: 'Advanced', models: ['glm-4.6', 'gpt-oss-20b-mlx'], maxTokens: 65536, supportedFeatures: ['tools'] }
    },
    longContextThresholdTokens: 100000,
    thinkingKeywords: [
      '思考',
      '深度思考',
      '逐步思考',
      '一步一步思考',
      '先思考再回答',
      '推理',
      '逻辑推理',
      '分析',
      '深度分析',
      '深入分析',
      '数据分析',
      'think step by step',
      'reason step by step',
      'step by step reasoning',
      'chain of thought',
      'deep analysis',
      'detailed analysis',
      'analyze',
      'analysis',
      'reasoning'
    ],
    // 优先级：vision > thinking > tools > longContext > coding > default
    routingDecisions: {
      default: { description: 'Default', modelTier: 'basic', tokenThreshold: 0, toolTypes: [], priority: 10 },
      vision:  { description: 'Vision',  modelTier: 'advanced', tokenThreshold: 0, toolTypes: [], priority: 90 },
      thinking: { description: 'Thinking', modelTier: 'advanced', tokenThreshold: 0, toolTypes: ['dataAnalysis'], priority: 80 },
      tools: { description: 'Tools', modelTier: 'advanced', tokenThreshold: 0, toolTypes: ['codeExecution', 'fileSearch', 'dataAnalysis', 'webSearch'], priority: 60 },
      longContext: { description: 'Long Context', modelTier: 'advanced', tokenThreshold: 100000, toolTypes: [], priority: 50 },
      coding: { description: 'Coding', modelTier: 'advanced', tokenThreshold: 0, toolTypes: ['codeExecution', 'fileSearch'], priority: 40 },
      webSearch: { description: 'Web Search', modelTier: 'advanced', tokenThreshold: 0, toolTypes: ['webSearch'], priority: 60 }
    },
    confidenceThreshold: 60
  };
}

async function listFiles(dir, pattern) {
  try {
    const all = await fsp.readdir(dir);
    return all.filter(f => pattern.test(f)).map(f => path.join(dir, f));
  } catch { return []; }
}

async function loadChatRequests() {
  const files = await listFiles(CHAT_DIR, /_provider-request\.json$/);
  const out = [];
  for (const file of files) {
    try {
      const j = safeParse(await fsp.readFile(file, 'utf-8'));
      const body = j && j.data && j.data.body ? j.data.body : null;
      if (body) out.push({ endpoint: '/v1/chat/completions', body, file });
    } catch {}
  }
  return out;
}

async function loadResponsesRequests() {
  // Use provider request snapshots as canonical Responses request payloads
  const files = await listFiles(RESP_DIR, /_pipeline\.provider\.request\.pre\.json$/);
  const out = [];
  for (const file of files) {
    try {
      const j = safeParse(await fsp.readFile(file, 'utf-8'));
      const body = j && j.data && j.data.payload ? j.data.payload : null;
      if (body) out.push({ endpoint: '/v1/responses', body, file });
    } catch {}
  }
  return out;
}

async function loadAnthropicRequests() {
  const files = await listFiles(ANTH_DIR, /_pipeline\.provider\.request\.pre\.json$/);
  const out = [];
  for (const file of files) {
    try {
      const j = safeParse(await fsp.readFile(file, 'utf-8'));
      const body = j && j.data && j.data.payload ? j.data.payload : null;
      if (body) out.push({ endpoint: '/v1/messages', body, file });
    } catch {}
  }
  return out;
}

async function main() {
  const ConfigRequestClassifier = await loadClassifier();

  // Try to load formal routingClassifierConfig from merged-config
  const mergedDir = path.join(process.cwd(), 'config');
  let classifierConfig = null;
  try {
    const primary = path.join(mergedDir, 'merged-config.json');
    const candidates = [primary];
    const list = await fsp.readdir(mergedDir);
    for (const f of list) {
      if (/^merged-config\..*\.json$/.test(f)) candidates.push(path.join(mergedDir, f));
    }
    for (const p of candidates) {
      try {
        const txt = await fsp.readFile(p, 'utf-8');
        const j = JSON.parse(txt);
        const c = j?.modules?.virtualrouter?.config?.classificationConfig;
        if (c && typeof c === 'object') { classifierConfig = c; break; }
      } catch {}
    }
  } catch {}

  const cfg = classifierConfig || buildClassifierConfig();
  if (!classifierConfig) {
    console.log('[route-dryrun-classify] Using built-in minimal classifier config (merged-config not found).');
  } else {
    console.log('[route-dryrun-classify] Loaded classifier config from merged-config.');
  }
  const cls = ConfigRequestClassifier.fromModuleConfig(cfg);

  const chatReqs = await loadChatRequests();
  const respReqs = await loadResponsesRequests();
  const anthReqs = await loadAnthropicRequests();
  const all = [...chatReqs, ...respReqs, ...anthReqs];

  const hitCounts = new Map();
  const categories = ['default','tools','coding','longContext','thinking','webSearch','vision'];
  for (const c of categories) hitCounts.set(c, 0);

  const samples = {};
  const misses = [];

  for (const item of all) {
    try {
      const res = await cls.classify({ request: item.body, endpoint: item.endpoint });
      const route = res && res.success ? String(res.route || 'default') : 'default';
      hitCounts.set(route, (hitCounts.get(route) || 0) + 1);
      if (!samples[route]) samples[route] = item.file;
    } catch (e) {
      misses.push({ file: item.file, error: String(e?.message || e) });
    }
  }

  const report = {
    scanned: all.length,
    byCategory: Object.fromEntries(Array.from(hitCounts.entries())),
    neverHit: categories.filter(c => (hitCounts.get(c) || 0) === 0),
    sampleByCategory: samples,
    errors: misses
  };

  const outDir = path.join(process.cwd(), 'docs', 'reports');
  await fsp.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'routing-classification-report.json');
  const mdPath = path.join(outDir, 'routing-classification-report.md');
  await fsp.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
  await fsp.writeFile(mdPath, `# Routing Classification Report\n\n- Scanned: ${report.scanned}\n- By Category: ${JSON.stringify(report.byCategory)}\n- Never Hit: ${report.neverHit.join(', ') || '(none)'}\n\n## Samples\n\n${Object.entries(samples).map(([k,v]) => `- ${k}: ${v}`).join('\n')}\n\n## Errors\n\n${report.errors.map(e => `- ${e.file}: ${e.error}`).join('\n') || '(none)'}\n`, 'utf-8');

  console.log('Routing classification report written to:');
  console.log(' -', jsonPath);
  console.log(' -', mdPath);
}

main().catch(err => { console.error('dry-run failed:', err); process.exit(1); });
