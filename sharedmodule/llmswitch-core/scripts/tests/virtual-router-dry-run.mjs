#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const args = new Map();
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key?.startsWith('--')) {
      if (value && !value.startsWith('--')) {
        args.set(key, value);
        i += 1;
      } else {
        args.set(key, 'true');
      }
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const samplesRoot =
  args.get('--samples') ||
  process.env.ROUTECODEX_SAMPLES_DIR ||
  path.join(os.homedir(), '.routecodex/codex-samples');
const configPath = path.resolve(
  repoRoot,
  args.get('--config') || 'test/virtual-router/virtual-router.config.json'
);
const scenariosPath = path.resolve(
  repoRoot,
  args.get('--scenarios') || 'test/virtual-router/scenarios.json'
);
const legacyOutputDir = path.resolve(repoRoot, 'dist', 'test-output', 'virtual-router');
const outputDir = path.resolve(repoRoot, 'test-results', 'virtual-router');
const limit = args.get('--limit') ? Number(args.get('--limit')) : null;

async function main() {
  // Avoid writing test artifacts into dist/, otherwise npm pack may accidentally ship them.
  try {
    await fs.rm(path.resolve(repoRoot, 'dist', 'test-output'), { recursive: true, force: true });
  } catch {
    // best-effort
  }

  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const scenarioList = await loadScenarios(scenariosPath);
  const scenarioMap = new Map();
  for (const scenario of scenarioList) {
    const absoluteSample = resolveSamplePath(scenario.sample);
    scenario.absoluteSample = absoluteSample;
    scenarioMap.set(absoluteSample, scenario);
  }

  const engineModule = await import(path.resolve(repoRoot, 'dist', 'router', 'virtual-router', 'engine.js'));
  const { VirtualRouterEngine } = engineModule;
  const engine = new VirtualRouterEngine();
  engine.initialize(config);

  const files = await collectSamples(samplesRoot, limit);
  const results = [];
  const stats = {
    totalSamples: files.length,
    processed: 0,
    routes: {},
    providers: {},
    errors: [],
    scenarios: {}
  };

  for (const filePath of files) {
    try {
      const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
      const standardized = buildStandardizedRequest(raw);
      if (!standardized) {
        stats.errors.push({ file: filePath, reason: 'Unable to build StandardizedRequest' });
        continue;
      }

      const meta = buildRouterMetadata(filePath, raw, standardized);
      const { target, decision, diagnostics } = engine.route(standardized, meta);
      stats.processed += 1;
      stats.routes[decision.routeName] = (stats.routes[decision.routeName] || 0) + 1;
      stats.providers[target.providerKey] = (stats.providers[target.providerKey] || 0) + 1;
      const record = {
        file: filePath,
        relativeFile: path.relative(samplesRoot, filePath),
        route: decision.routeName,
        providerKey: target.providerKey,
        reasoning: diagnostics.reasoning || decision.reasoning,
        confidence: decision.confidence,
        stream: meta.stream === true
      };
      results.push(record);

      if (scenarioMap.has(filePath)) {
        const scenario = scenarioMap.get(filePath);
        stats.scenarios[scenario.id] = {
          expectedRoute: scenario.expectedRoute,
          actualRoute: decision.routeName,
          match: scenario.expectedRoute ? scenario.expectedRoute === decision.routeName : true
        };
      }
    } catch (error) {
      stats.errors.push({ file: filePath, reason: error.message });
    }
  }

  await fs.mkdir(outputDir, { recursive: true });
  const summaryPath = path.join(outputDir, 'summary.json');
  const detailsPath = path.join(outputDir, 'results.json');
  await fs.writeFile(summaryPath, JSON.stringify({ samplesRoot, configPath, stats }, null, 2), 'utf8');
  await fs.writeFile(detailsPath, JSON.stringify(results, null, 2), 'utf8');

  console.log(`[virtual-router] processed ${stats.processed}/${stats.totalSamples} snapshots`);
  console.log(`[virtual-router] summary => ${summaryPath}`);
  console.log(`[virtual-router] detailed results => ${detailsPath}`);
  if (legacyOutputDir !== outputDir) {
    console.log(`[virtual-router] legacy output dir cleaned (dist/test-output)`);
  }
}

function resolveSamplePath(samplePath) {
  if (path.isAbsolute(samplePath)) {
    return samplePath;
  }
  return path.join(samplesRoot, samplePath);
}

async function loadScenarios(filePath) {
  try {
    const json = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (Array.isArray(json)) {
      return json;
    }
    return [];
  } catch {
    return [];
  }
}

async function collectSamples(rootDir, max) {
  const files = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        if (max && files.length >= max) {
          return;
        }
      } else if (entry.isFile() && entry.name.endsWith('_http-request.json')) {
        files.push(fullPath);
        if (max && files.length >= max) {
          return;
        }
      }
    }
  }
  await walk(rootDir);
  return files;
}

function buildStandardizedRequest(snapshot) {
  const payload = snapshot?.data ?? snapshot?.body ?? snapshot;
  if (!payload) {
    return null;
  }
  const messages = normalizeMessages(payload);
  if (!messages.length) {
    return null;
  }
  const parameters = collectParameters(payload);
  const metadata = {
    originalEndpoint: snapshot?.data?.entryEndpoint || '/v1/chat/completions',
    requestId: payload?.route?.requestId || snapshot?.data?.route?.requestId || null,
    stream: payload?.stream === true,
    routeHint: payload?.metadata?.routeHint
  };
  return {
    model: typeof payload.model === 'string' ? payload.model : 'unknown',
    messages,
    tools: Array.isArray(payload.tools) ? payload.tools : undefined,
    parameters,
    metadata
  };
}

function normalizeMessages(payload) {
  if (Array.isArray(payload.messages)) {
    return payload.messages
      .map(({ role, content, tool_calls }) => ({
        role: typeof role === 'string' ? role : 'user',
        content: flattenChatContent(content),
        tool_calls
      }))
      .filter((msg) => typeof msg.content === 'string');
  }
  if (Array.isArray(payload.input)) {
    const items = [];
    if (typeof payload.instructions === 'string' && payload.instructions.trim()) {
      items.push({
        role: 'system',
        content: payload.instructions.trim()
      });
    }
    for (const block of payload.input) {
      const content = flattenResponsesContent(block?.content);
      items.push({
        role: typeof block?.role === 'string' ? block.role : 'user',
        content
      });
    }
    return items;
  }
  if (typeof payload.prompt === 'string') {
    return [{ role: 'user', content: payload.prompt }];
  }
  if (typeof payload.content === 'string') {
    return [{ role: 'user', content: payload.content }];
  }
  return [];
}

function flattenChatContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item === 'object') {
          if (typeof item.text === 'string') {
            return item.text;
          }
          if (typeof item.content === 'string') {
            return item.content;
          }
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    return content.text || content.content || '';
  }
  return '';
}

function flattenResponsesContent(block) {
  if (!block) {
    return '';
  }
  if (typeof block === 'string') {
    return block;
  }
  if (Array.isArray(block)) {
    return block
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object') {
          if (part.type === 'output_text' && typeof part.text === 'string') {
            return part.text;
          }
          if (part.type === 'text' && typeof part.text === 'string') {
            return part.text;
          }
          if (part.type === 'image_url' && part.image_url) {
            return `[image:${part.image_url.url || 'embedded'}]`;
          }
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof block === 'object' && typeof block.text === 'string') {
    return block.text;
  }
  return '';
}

function collectParameters(payload) {
  const candidates = ['temperature', 'top_p', 'max_tokens', 'stream', 'tool_choice', 'modal', 'max_output_tokens'];
  const parameters = {};
  for (const key of candidates) {
    if (payload[key] !== undefined) {
      parameters[key] = payload[key];
    }
  }
  parameters.model = payload.model;
  return parameters;
}

function buildRouterMetadata(filePath, snapshot, standardized) {
  const relative = path.relative(samplesRoot, filePath);
  const providerProtocol = inferProviderProtocol(relative);
  const entryEndpoint = inferEntryEndpoint(providerProtocol);
  const metadata = snapshot?.data?.metadata && typeof snapshot.data.metadata === 'object' ? snapshot.data.metadata : {};
  const requestId =
    metadata.requestId ||
    snapshot?.data?.route?.requestId ||
    standardized?.metadata?.requestId ||
    path.basename(filePath, '.json');
  return {
    requestId,
    entryEndpoint,
    processMode: metadata.processMode === 'passthrough' ? 'passthrough' : 'chat',
    stream: metadata.stream === true || standardized?.metadata?.stream === true,
    direction: 'request',
    providerProtocol,
    stage: 'inbound',
    routeHint: metadata.routeHint || standardized?.metadata?.routeHint
  };
}

function inferProviderProtocol(relativePath) {
  if (relativePath.includes('openai-chat')) {
    return 'openai-chat';
  }
  if (relativePath.includes('openai-responses')) {
    return 'openai-responses';
  }
  if (relativePath.includes('anthropic-messages')) {
    return 'anthropic-messages';
  }
  return 'openai-chat';
}

function inferEntryEndpoint(protocol) {
  switch (protocol) {
    case 'openai-responses':
      return '/v1/responses';
    case 'anthropic-messages':
      return '/v1/messages';
    default:
      return '/v1/chat/completions';
  }
}

await main();
