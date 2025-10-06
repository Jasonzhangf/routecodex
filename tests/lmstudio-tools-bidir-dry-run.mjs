#!/usr/bin/env node
// LM Studio tools calling: real request + recorded response → full dry-run at each stage

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

async function createLogger() {
  const mod = await importFromDist('modules/pipeline/utils/debug-logger.js');
  const { PipelineDebugLogger } = mod;
  const debugCenter = { processDebugEvent: () => {} };
  return new PipelineDebugLogger(debugCenter, { enableConsoleLogging: true, logLevel: 'basic' });
}

async function importFromDist(rel) {
  const p = path.join(repoRoot, 'dist', rel);
  const href = url.pathToFileURL(p).href;
  return await import(href);
}

async function main() {
  const logger = await createLogger();
  const errorHandlingCenter = { handleError: async () => {}, createContext: () => ({}) };
  const debugCenter = { processDebugEvent: () => {} };
  const dependencies = { errorHandlingCenter, debugCenter, logger };

  // Load configs and request
  const userConf = readJSON(path.join(repoRoot, 'config', 'config.json'));
  const reqPath = path.join(repoRoot, 'examples', 'lmstudio-tools-request.json');
  const requestBody = readJSON(reqPath);

  const lmstudioConf = userConf?.virtualrouter?.providers?.lmstudio || {};
  const baseUrl = process.env.LMSTUDIO_BASE_URL || process.env.LM_STUDIO_BASE_URL || lmstudioConf.baseURL || 'http://localhost:1234';
  const apiKey = process.env.LMSTUDIO_API_KEY || (Array.isArray(lmstudioConf.apiKey) ? lmstudioConf.apiKey[0] : '');

  // Build modules from dist
  const { OpenAINormalizerLLMSwitch } = await importFromDist('modules/pipeline/modules/llmswitch/llmswitch-openai-openai.js');
  const { LMStudioCompatibility } = await importFromDist('modules/pipeline/modules/compatibility/lmstudio-compatibility.js');
  const { LMStudioProviderSimple } = await importFromDist('modules/pipeline/modules/provider/lmstudio-provider-simple.js');
  const { dryRunPipelineExecutor } = await importFromDist('modules/pipeline/dry-run/dry-run-pipeline-executor.js');
  const { pipelineDryRunManager } = await importFromDist('modules/pipeline/dry-run/pipeline-dry-run-framework.js');

  // Instantiate real modules
  const llmSwitch = new OpenAINormalizerLLMSwitch({ type: 'llmswitch-openai-openai', config: {} }, dependencies);
  const compatibility = new LMStudioCompatibility({ type: 'lmstudio-compatibility', config: { toolsEnabled: true } }, dependencies);
  const provider = new LMStudioProviderSimple({ type: 'lmstudio-http', config: { baseUrl, auth: { type: 'apikey', apiKey } } }, dependencies);

  await llmSwitch.initialize();
  await compatibility.initialize();
  await provider.initialize();

  // Configure node-level dry-run for request side
  pipelineDryRunManager.clear();
  pipelineDryRunManager.configureNodesDryRun({
    'llm-switch': { enabled: true, mode: 'output-validation', breakpointBehavior: 'continue', verbosity: 'normal' },
    'compatibility': { enabled: true, mode: 'output-validation', breakpointBehavior: 'pause', verbosity: 'detailed' }
  });

  // Register request pipeline nodes: llm-switch → compatibility → provider
  dryRunPipelineExecutor.cleanup();
  dryRunPipelineExecutor.registerNodes([
    { id: 'llm-switch', type: 'llm-switch', module: llmSwitch, isDryRun: true, config: pipelineDryRunManager.getNodeConfig('llm-switch') },
    { id: 'compatibility', type: 'compatibility', module: compatibility, isDryRun: true, config: pipelineDryRunManager.getNodeConfig('compatibility') },
    { id: 'provider', type: 'provider', module: provider, isDryRun: false }
  ]);
  dryRunPipelineExecutor.setExecutionOrder(['llm-switch', 'compatibility', 'provider']);

  // Build pipeline request wrapper
  const pipelineRequest = {
    data: requestBody,
    route: { providerId: 'lmstudio', modelId: requestBody.model, requestId: `req_${Date.now()}`, timestamp: Date.now() },
    metadata: { source: 'test', stage: 'request' },
    debug: { enabled: true, stages: {} }
  };

  // Execute request pipeline in mixed mode (dry-run nodes + real provider)
  const reqResult = await dryRunPipelineExecutor.executePipeline(pipelineRequest, 'lmstudio.request', 'mixed');

  // Extract real provider response
  const ctx = dryRunPipelineExecutor.getExecutionContext(pipelineRequest.route.requestId);
  const providerResult = ctx ? ctx.executionData.get('provider') : null;
  const realResponse = providerResult?.data || providerResult || null;

  if (!realResponse) {
    console.error('No provider response captured. Aborting.');
    process.exit(1);
  }

  const outDir = path.join(repoRoot, 'tests', 'output');
  writeJSON(path.join(outDir, 'lmstudio-real-response.json'), realResponse);

  // Response-side dry-run wrappers to call processOutgoing
  function wrapForResponse(id, type, underlying) {
    return {
      id: `${id}-wrapper-${Date.now()}`,
      type,
      config: { type, config: {} },
      async initialize() {},
      async processIncoming(resp) { return type === 'compatibility' ? underlying.processOutgoing(resp) : underlying.processOutgoing(resp); },
      async processOutgoing(resp) { return resp; },
      async cleanup() {},
      async executeNodeDryRun(request, context) {
        const start = Date.now();
        let output, status = 'success';
        try { output = await this.processIncoming(request); }
        catch (e) { status = 'error'; output = null; }
        const time = Date.now() - start;
        return {
          nodeId: context.nodeId,
          nodeType: context.nodeType,
          status,
          inputData: request,
          expectedOutput: output,
          validationResults: [],
          performanceMetrics: { estimatedTime: time, estimatedMemory: 0, complexity: 1 },
          executionLog: [{ timestamp: Date.now(), level: 'info', message: 'response-stage dry-run', data: { time } }]
        };
      }
    };
  }

  const respCompat = wrapForResponse('response-compatibility', 'compatibility', compatibility);
  const respSwitch = wrapForResponse('response-llm-switch', 'llm-switch', llmSwitch);

  // Configure response-side dry-run
  pipelineDryRunManager.clear();
  pipelineDryRunManager.configureNodesDryRun({
    'response-compatibility': { enabled: true, mode: 'full-analysis', breakpointBehavior: 'continue', verbosity: 'normal' },
    'response-llm-switch': { enabled: true, mode: 'output-validation', breakpointBehavior: 'continue', verbosity: 'normal' }
  });

  // Register response pipeline and execute purely in dry-run (no outbound HTTP)
  dryRunPipelineExecutor.cleanup();
  dryRunPipelineExecutor.registerNodes([
    { id: 'response-compatibility', type: 'compatibility', module: respCompat, isDryRun: true, config: pipelineDryRunManager.getNodeConfig('response-compatibility') },
    { id: 'response-llm-switch', type: 'llm-switch', module: respSwitch, isDryRun: true, config: pipelineDryRunManager.getNodeConfig('response-llm-switch') }
  ]);
  dryRunPipelineExecutor.setExecutionOrder(['response-compatibility', 'response-llm-switch']);

  const responsePipelineRequest = {
    data: realResponse,
    route: { providerId: 'lmstudio', modelId: requestBody.model, requestId: `resp_${Date.now()}`, timestamp: Date.now() },
    metadata: { source: 'test', stage: 'response' },
    debug: { enabled: true, stages: {} }
  };

  const respResult = await dryRunPipelineExecutor.executePipeline(responsePipelineRequest, 'lmstudio.response', 'dry-run');

  // Persist reports
  writeJSON(path.join(outDir, 'lmstudio-request-dryrun-report.json'), reqResult);
  writeJSON(path.join(outDir, 'lmstudio-response-dryrun-report.json'), respResult);

  console.log('\n✓ LMStudio bidirectional dry-run completed.');
  console.log('  - Real response: tests/output/lmstudio-real-response.json');
  console.log('  - Request dry-run report: tests/output/lmstudio-request-dryrun-report.json');
  console.log('  - Response dry-run report: tests/output/lmstudio-response-dryrun-report.json');
}

// Support both require and direct node execution
if (process.argv[1] && process.argv[1].endsWith('lmstudio-tools-bidir-dry-run.mjs')) {
  main().catch(err => {
    console.error('Failed to run LMStudio bidirectional dry-run:', err?.stack || String(err));
    process.exit(1);
  });
}
