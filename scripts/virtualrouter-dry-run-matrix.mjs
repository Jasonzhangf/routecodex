#!/usr/bin/env node
// Virtual Router dry-run matrix: generate synthetic requests per category
// and report routing decisions against a given config.
//
// Usage:
//   node scripts/virtualrouter-dry-run-matrix.mjs --config <path>
//
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

function parseArgs() {
  const out = { config: '' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--config' || a === '-c') && argv[i+1]) { out.config = argv[++i]; continue; }
  }
  if (!out.config) throw new Error('Usage: --config <path>');
  return out;
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function resolveFromRepo(rel) {
  // Prefer repo-local path; fallback to CWD if running from worktree
  const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
  const p = path.resolve(__dirname, '..', rel);
  if (fs.existsSync(p)) return p;
  const cwdp = path.resolve(process.cwd(), rel);
  return cwdp;
}

async function importDist(rel) {
  const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
  const modPath = path.resolve(__dirname, '..', 'dist', rel);
  return await import(url.pathToFileURL(modPath).href);
}

function makeRequests() {
  const longText = Array.from({ length: 200 }, (_, i) => `段落${i+1}：这是为了长上下文分类的占位文本。`).join(' ');
  const tools = [{ type: 'function', function: { name: 'list_local_files', description: 'List local files', parameters: { type: 'object', properties: { dir: { type: 'string' } }, required: ['dir'] } } }];
  return [
    { name: 'default', body: { model: 'auto', messages: [ { role: 'user', content: '你好，请简单自我介绍。' } ], stream: false } },
    { name: 'tools', body: { model: 'auto', messages: [ { role: 'user', content: '请调用工具 list_local_files 列出当前目录文件。' } ], tools, tool_choice: { type: 'function', function: { name: 'list_local_files' } }, stream: false } },
    { name: 'coding', body: { model: 'auto', messages: [ { role: 'user', content: '请用JavaScript实现冒泡排序，并提供示例。\n```js\n// your code here\n```' } ], stream: false } },
    { name: 'thinking', body: { model: 'auto', messages: [ { role: 'user', content: '请逐步推理，详细说明你的思考过程，然后给出最终结论。' } ], stream: false } },
    { name: 'longcontext', body: { model: 'auto', messages: [ { role: 'user', content: longText } ], stream: false } },
    { name: 'vision', body: { model: 'auto', messages: [ { role: 'user', content: [ { type: 'text', text: '请描述这张图片的内容' }, { type: 'image_url', image_url: { url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Example.jpg/240px-Example.jpg' } } ] } ], stream: false } },
    { name: 'websearch', body: { model: 'auto', messages: [ { role: 'user', content: '请上网搜索今天的科技新闻头条并做简报。' } ], stream: false } },
    { name: 'background', body: { model: 'auto', messages: [ { role: 'user', content: '这是一个需要在后台安静处理的任务，请异步完成。' } ], stream: false } },
  ];
}

async function main() {
  const args = parseArgs();
  const configPath = path.resolve(args.config.replace(/^~\//, `${process.env.HOME || ''}/`));
  if (!fs.existsSync(configPath)) throw new Error(`Config not found: ${configPath}`);

  // Try repo-local modules.json; fallback to current repo's config/modules.json
  let modulesJson = resolveFromRepo('../config/modules.json');
  if (!fs.existsSync(modulesJson)) {
    modulesJson = resolveFromRepo('config/modules.json');
  }
  const modulesConfig = readJson(modulesJson);
  const classificationConfig = modulesConfig?.modules?.virtualrouter?.config?.classificationConfig;
  if (!classificationConfig) throw new Error('classificationConfig missing from config/modules.json');

  const userConfig = readJson(configPath);
  const { VirtualRouterDryRunExecutor } = await importDist('modules/virtual-router/virtual-router-dry-run.js');
  const exec = new VirtualRouterDryRunExecutor({ enabled: true, includeLoadBalancerDetails: true, includeHealthStatus: true, includeWeightCalculation: true, simulateProviderHealth: true });
  await exec.initialize({ classificationConfig, userConfig });

  const reqs = makeRequests();
  const routingConfig = (userConfig?.virtualrouter?.routing) || {};

  const results = [];
  for (const r of reqs) {
    const res = await exec.executeDryRun({ request: r.body, endpoint: '/v1/chat/completions', protocol: 'openai' });
    results.push({
      category: r.name,
      route: res?.routingDecision?.route || 'default',
      confidence: res?.routingDecision?.confidence ?? null,
      alternativeRoutes: res?.routingDecision?.alternativeRoutes || [],
      configuredTargetsForCategory: routingConfig[r.name] || [],
      configuredTargetsForDecisionRoute: routingConfig[res?.routingDecision?.route || 'default'] || [],
      decision: res?.routingDecision || null,
    });
  }

  console.log(JSON.stringify({ config: configPath, results }, null, 2));
}

main().catch((e) => { console.error('vr-dry-run-matrix failed:', e?.message || e); process.exit(1); });
