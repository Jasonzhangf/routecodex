#!/usr/bin/env node
// LM Studio Comprehensive Dry-Run: Full pipeline with response analysis focus

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
  return new PipelineDebugLogger(debugCenter, { enableConsoleLogging: true, logLevel: 'detailed' });
}

async function importFromDist(rel) {
  const p = path.join(repoRoot, 'dist', rel);
  const href = url.pathToFileURL(p).href;
  return await import(href);
}

async function main() {
  console.log('🚀 Starting LM Studio Comprehensive Dry-Run...\n');

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

  console.log('📋 Configuration:');
  console.log(`  - Base URL: ${baseUrl}`);
  console.log(`  - Model: ${requestBody.model}`);
  console.log(`  - Tools: ${requestBody.tools?.length || 0} defined`);
  console.log(`  - Request ID: ${Date.now()}`);

  // Build modules from dist
  const { OpenAIPassthroughLLMSwitch } = await importFromDist('modules/pipeline/modules/llmswitch/openai-passthrough.js');
  const { LMStudioCompatibility } = await importFromDist('modules/pipeline/modules/compatibility/lmstudio-compatibility.js');
  const { LMStudioProviderSimple } = await importFromDist('modules/pipeline/modules/provider/lmstudio-provider-simple.js');
  const { dryRunPipelineExecutor } = await importFromDist('modules/pipeline/dry-run/dry-run-pipeline-executor.js');
  const { pipelineDryRunManager } = await importFromDist('modules/pipeline/dry-run/pipeline-dry-run-framework.js');

  // Instantiate real modules
  const llmSwitch = new OpenAIPassthroughLLMSwitch({ type: 'openai-passthrough', config: {} }, dependencies);
  const compatibility = new LMStudioCompatibility({ type: 'lmstudio-compatibility', config: { toolsEnabled: true } }, dependencies);
  const provider = new LMStudioProviderSimple({ type: 'lmstudio-http', config: { baseUrl, auth: { type: 'apikey', apiKey } } }, dependencies);

  await llmSwitch.initialize();
  await compatibility.initialize();
  await provider.initialize();

  console.log('✅ Modules initialized successfully');

  // === STAGE 1: Request Pipeline with Detailed Dry-Run ===
  console.log('\n🔄 Stage 1: Request Pipeline (Dry-Run + Real Provider)');

  // Configure detailed node-level dry-run for request side
  pipelineDryRunManager.clear();
  pipelineDryRunManager.configureNodesDryRun({
    'llm-switch': {
      enabled: true,
      mode: 'full-analysis',
      breakpointBehavior: 'continue',
      verbosity: 'detailed',
      captureExecution: true
    },
    'compatibility': {
      enabled: true,
      mode: 'full-analysis',
      breakpointBehavior: 'pause',
      verbosity: 'detailed',
      captureExecution: true
    }
  });

  // Register request pipeline nodes
  dryRunPipelineExecutor.cleanup();
  dryRunPipelineExecutor.registerNodes([
    { id: 'llm-switch', type: 'llm-switch', module: llmSwitch, isDryRun: true, config: pipelineDryRunManager.getNodeConfig('llm-switch') },
    { id: 'compatibility', type: 'compatibility', module: compatibility, isDryRun: true, config: pipelineDryRunManager.getNodeConfig('compatibility') },
    { id: 'provider', type: 'provider', module: provider, isDryRun: false }
  ]);
  dryRunPipelineExecutor.setExecutionOrder(['llm-switch', 'compatibility', 'provider']);

  const pipelineRequest = {
    data: requestBody,
    route: { providerId: 'lmstudio', modelId: requestBody.model, requestId: `req_${Date.now()}`, timestamp: Date.now() },
    metadata: { source: 'test', stage: 'request' },
    debug: { enabled: true, stages: {} }
  };

  console.log('📤 Executing request pipeline...');
  const reqResult = await dryRunPipelineExecutor.executePipeline(pipelineRequest, 'lmstudio.request', 'mixed');

  // Extract real provider response
  const ctx = dryRunPipelineExecutor.getExecutionContext(pipelineRequest.route.requestId);
  const providerResult = ctx ? ctx.executionData.get('provider') : null;
  const realResponse = providerResult?.data || providerResult || null;

  if (!realResponse) {
    console.error('❌ No provider response captured. Aborting.');
    process.exit(1);
  }

  console.log('✅ Real response captured successfully');
  console.log(`  - Response ID: ${realResponse.id || 'unknown'}`);
  console.log(`  - Model: ${realResponse.model || requestBody.model}`);
  console.log(`  - Choices: ${realResponse.choices?.length || 0}`);
  console.log(`  - Tool calls: ${realResponse.choices?.[0]?.message?.tool_calls?.length || 0}`);

  const outDir = path.join(repoRoot, 'tests', 'output');
  writeJSON(path.join(outDir, 'lmstudio-real-response.json'), realResponse);
  writeJSON(path.join(outDir, 'lmstudio-request-dryrun-report.json'), reqResult);

  // === STAGE 2: Response Pipeline Dry-Run (Focus Area) ===
  console.log('\n🔄 Stage 2: Response Pipeline Dry-Run (Analysis Focus)');

  // Enhanced response wrappers with detailed logging
  function createResponseWrapper(id, type, underlying) {
    return {
      id: `${id}-response-wrapper-${Date.now()}`,
      type,
      config: { type, config: {} },
      executionStats: { startTime: 0, endTime: 0, steps: [] },

      async initialize() {
        console.log(`🔧 Initializing ${id} response wrapper`);
      },

      async processIncoming(response) {
        const stepStart = Date.now();
        console.log(`📥 ${id} processing incoming response...`);

        let result;
        try {
          if (type === 'compatibility') {
            result = await underlying.processOutgoing(response);
          } else {
            result = await underlying.processOutgoing(response);
          }

          const stepTime = Date.now() - stepStart;
          this.executionStats.steps.push({
            step: 'processIncoming',
            duration: stepTime,
            success: true,
            inputSize: JSON.stringify(response).length,
            outputSize: JSON.stringify(result).length
          });

          console.log(`✅ ${id} processed response successfully (${stepTime}ms)`);
          return result;
        } catch (error) {
          const stepTime = Date.now() - stepStart;
          this.executionStats.steps.push({
            step: 'processIncoming',
            duration: stepTime,
            success: false,
            error: error.message
          });
          console.error(`❌ ${id} failed to process response:`, error.message);
          throw error;
        }
      },

      async processOutgoing(response) {
        return response;
      },

      async cleanup() {
        console.log(`🧹 Cleaning up ${id} response wrapper`);
      },

      async executeNodeDryRun(request, context) {
        const startTime = Date.now();
        this.executionStats.startTime = startTime;

        console.log(`🔍 ${id} dry-run execution started`);
        console.log(`  - Node ID: ${context.nodeId}`);
        console.log(`  - Context: ${JSON.stringify(context.metadata || {})}`);

        let output, status = 'success';
        let error = null;

        try {
          output = await this.processIncoming(request);
          status = 'success';
        } catch (e) {
          status = 'error';
          error = e;
          output = null;
        }

        const endTime = Date.now();
        this.executionStats.endTime = endTime;
        const totalTime = endTime - startTime;

        const dryRunResult = {
          nodeId: context.nodeId,
          nodeType: context.nodeType,
          status,
          inputData: request,
          expectedOutput: output,
          validationResults: [{
            type: 'execution-time',
            passed: totalTime < 10000, // 10s threshold
            message: `Execution time: ${totalTime}ms`
          }],
          performanceMetrics: {
            estimatedTime: totalTime,
            estimatedMemory: 0,
            complexity: 1,
            executionStats: this.executionStats
          },
          executionLog: [
            { timestamp: startTime, level: 'info', message: 'response-stage dry-run started' },
            { timestamp: endTime, level: status === 'success' ? 'info' : 'error', message: `response-stage dry-run ${status}`, data: { time: totalTime, error: error?.message } }
          ],
          metadata: {
            wrapperId: this.id,
            totalSteps: this.executionStats.steps.length,
            successfulSteps: this.executionStats.steps.filter(s => s.success).length
          }
        };

        console.log(`🎯 ${id} dry-run completed (${totalTime}ms, status: ${status})`);
        return dryRunResult;
      }
    };
  }

  const respCompat = createResponseWrapper('compatibility', 'compatibility', compatibility);
  const respSwitch = createResponseWrapper('llm-switch', 'llm-switch', llmSwitch);

  // Configure response-side dry-run with detailed analysis
  pipelineDryRunManager.clear();
  pipelineDryRunManager.configureNodesDryRun({
    'response-compatibility': {
      enabled: true,
      mode: 'full-analysis',
      breakpointBehavior: 'continue',
      verbosity: 'detailed',
      captureExecution: true,
      analyzeTransformations: true
    },
    'response-llm-switch': {
      enabled: true,
      mode: 'full-analysis',
      breakpointBehavior: 'continue',
      verbosity: 'detailed',
      captureExecution: true,
      analyzeTransformations: true
    }
  });

  // Register response pipeline for detailed analysis
  dryRunPipelineExecutor.cleanup();
  dryRunPipelineExecutor.registerNodes([
    { id: 'response-compatibility', type: 'compatibility', module: respCompat, isDryRun: true, config: pipelineDryRunManager.getNodeConfig('response-compatibility') },
    { id: 'response-llm-switch', type: 'llm-switch', module: respSwitch, isDryRun: true, config: pipelineDryRunManager.getNodeConfig('response-llm-switch') }
  ]);
  dryRunPipelineExecutor.setExecutionOrder(['response-compatibility', 'response-llm-switch']);

  const responsePipelineRequest = {
    data: realResponse,
    route: { providerId: 'lmstudio', modelId: requestBody.model, requestId: `resp_${Date.now()}`, timestamp: Date.now() },
    metadata: { source: 'test', stage: 'response', originalRequestId: pipelineRequest.route.requestId },
    debug: { enabled: true, stages: {} }
  };

  console.log('📥 Executing response pipeline dry-run...');
  const respResult = await dryRunPipelineExecutor.executePipeline(responsePipelineRequest, 'lmstudio.response', 'dry-run');

  // === STAGE 3: Analysis and Reporting ===
  console.log('\n📊 Stage 3: Analysis and Report Generation');

  // Generate comprehensive analysis report
  const analysisReport = {
    executionSummary: {
      totalExecutionTime: respResult.overallMetrics?.totalExecutionTime || 0,
      requestPipelineTime: reqResult.overallMetrics?.totalExecutionTime || 0,
      responsePipelineTime: respResult.overallMetrics?.totalExecutionTime || 0,
      timestamp: new Date().toISOString(),
      model: requestBody.model,
      provider: 'lmstudio'
    },
    requestAnalysis: {
      llmSwitchAnalysis: reqResult.nodeResults?.['llm-switch'] || null,
      compatibilityAnalysis: reqResult.nodeResults?.['compatibility'] || null,
      providerResponse: {
        id: realResponse.id,
        model: realResponse.model,
        choices: realResponse.choices?.length || 0,
        toolCalls: realResponse.choices?.[0]?.message?.tool_calls?.length || 0,
        usage: realResponse.usage || {}
      }
    },
    responseAnalysis: {
      compatibilityTransform: respResult.nodeResults?.['response-compatibility'] || null,
      llmSwitchTransform: respResult.nodeResults?.['response-llm-switch'] || null,
      transformationChain: []
    },
    performanceMetrics: {
      requestStage: reqResult.overallMetrics || {},
      responseStage: respResult.overallMetrics || {},
      nodeBreakdown: {}
    }
  };

  // Build transformation chain
  if (respResult.nodeResults) {
    Object.entries(respResult.nodeResults).forEach(([nodeId, result]) => {
      analysisReport.responseAnalysis.transformationChain.push({
        node: nodeId,
        executionTime: result.performanceMetrics?.estimatedTime || 0,
        status: result.status,
        inputSize: result.inputData ? JSON.stringify(result.inputData).length : 0,
        outputSize: result.expectedOutput ? JSON.stringify(result.expectedOutput).length : 0,
        validationResults: result.validationResults || []
      });
    });
  }

  // Persist all reports
  writeJSON(path.join(outDir, 'lmstudio-response-dryrun-report.json'), respResult);
  writeJSON(path.join(outDir, 'lmstudio-comprehensive-analysis.json'), analysisReport);

  console.log('\n✅ LM Studio Comprehensive Dry-Run Completed!');
  console.log('📁 Output Files:');
  console.log('  - Real response: tests/output/lmstudio-real-response.json');
  console.log('  - Request dry-run: tests/output/lmstudio-request-dryrun-report.json');
  console.log('  - Response dry-run: tests/output/lmstudio-response-dryrun-report.json');
  console.log('  - Comprehensive analysis: tests/output/lmstudio-comprehensive-analysis.json');

  // Summary statistics
  const totalNodes = (reqResult.nodeResults ? Object.keys(reqResult.nodeResults).length : 0) +
                     (respResult.nodeResults ? Object.keys(respResult.nodeResults).length : 0);
  const successfulNodes = (reqResult.nodeResults ? Object.values(reqResult.nodeResults).filter(r => r.status === 'success').length : 0) +
                         (respResult.nodeResults ? Object.values(respResult.nodeResults).filter(r => r.status === 'success').length : 0);

  console.log('\n📈 Summary Statistics:');
  console.log(`  - Total nodes executed: ${totalNodes}`);
  console.log(`  - Successful nodes: ${successfulNodes}`);
  console.log(`  - Success rate: ${totalNodes > 0 ? Math.round((successfulNodes / totalNodes) * 100) : 0}%`);
  console.log(`  - Total execution time: ${analysisReport.executionSummary.totalExecutionTime}ms`);
}

// Support both require and direct node execution
if (process.argv[1] && process.argv[1].endsWith('lmstudio-comprehensive-dry-run.mjs')) {
  main().catch(err => {
    console.error('Failed to run LM Studio comprehensive dry-run:', err?.stack || String(err));
    process.exit(1);
  });
}