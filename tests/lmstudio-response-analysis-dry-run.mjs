#!/usr/bin/env node
// LM Studio Response Analysis Dry-Run: Focus on response transformation analysis

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

async function importFromDist(rel) {
  const p = path.join(repoRoot, 'dist', rel);
  const href = url.pathToFileURL(p).href;
  return await import(href);
}

async function main() {
  console.log('🔍 LM Studio Response Analysis Dry-Run - Focus on Response Transformations\n');

  // Check if we have a real response file, otherwise generate one
  const realResponsePath = path.join(repoRoot, 'tests', 'output', 'lmstudio-real-response.json');
  let realResponse;

  if (fs.existsSync(realResponsePath)) {
    realResponse = readJSON(realResponsePath);
    console.log('📄 Using existing real response from file');
  } else {
    console.log('📄 No existing response found, running quick request to generate one...');

    // Quick generation of real response
    const { dryRunEngine } = await importFromDist('modules/dry-run-engine/core/engine.js');
    const { OpenAIPassthroughLLMSwitch } = await importFromDist('modules/pipeline/modules/llmswitch/openai-passthrough.js');
    const { LMStudioCompatibility } = await importFromDist('modules/pipeline/modules/compatibility/lmstudio-compatibility.js');
    const { LMStudioProviderSimple } = await importFromDist('modules/pipeline/modules/provider/lmstudio-provider-simple.js');

    const logger = {
      log: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      logModule: () => {}
    };
    const errorHandlingCenter = { handleError: async () => {}, createContext: () => ({}) };
    const debugCenter = { processDebugEvent: () => {} };
    const dependencies = { errorHandlingCenter, debugCenter, logger };

    const requestBody = {
      model: "gpt-oss-20b-mlx",
      messages: [
        { role: "system", content: "You are a helpful assistant that can use tools when needed." },
        { role: "user", content: "What's the weather in San Francisco today?" }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get current weather by city name",
            parameters: {
              type: "object",
              properties: {
                city: { type: "string", description: "City name" },
                unit: { type: "string", enum: ["celsius", "fahrenheit"], description: "Temperature unit" }
              },
              required: ["city"]
            }
          }
        }
      ],
      temperature: 0.2,
      max_tokens: 256
    };

    const baseUrl = process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234';
    const apiKey = process.env.LMSTUDIO_API_KEY || '';

    const llmSwitch = new OpenAIPassthroughLLMSwitch({ type: 'openai-passthrough', config: {} }, dependencies);
    const compatibility = new LMStudioCompatibility({ type: 'lmstudio-compatibility', config: { toolsEnabled: true } }, dependencies);
    const provider = new LMStudioProviderSimple({ type: 'lmstudio-http', config: { baseUrl, auth: { type: 'apikey', apiKey } } }, dependencies);

    await llmSwitch.initialize();
    await compatibility.initialize();
    await provider.initialize();

    // Execute quick request
    const quickResult = await dryRunEngine.runRequest({
      data: requestBody,
      route: { providerId: 'lmstudio', modelId: requestBody.model, requestId: `quick_${Date.now()}`, timestamp: Date.now() },
      metadata: { source: 'test', stage: 'request' },
      debug: { enabled: false, stages: {} }
    }, {
      mode: 'mixed',
      nodeConfigs: {
        'llm-switch': { enabled: false },
        'compatibility': { enabled: false },
        'provider': { enabled: false }
      }
    });

    // Extract the actual response (this will be the raw HTTP response)
    realResponse = quickResult.data || quickResult;

    // Save for future use
    writeJSON(realResponsePath, realResponse);
    console.log('✅ Generated and saved real response');
  }

  console.log(`📊 Response Details:`);
  console.log(`  - Response ID: ${realResponse.id || 'unknown'}`);
  console.log(`  - Model: ${realResponse.model || 'unknown'}`);
  console.log(`  - Object: ${realResponse.object || 'unknown'}`);
  console.log(`  - Choices: ${realResponse.choices?.length || 0}`);

  if (realResponse.choices?.[0]?.message?.tool_calls) {
    console.log(`  - Tool calls: ${realResponse.choices[0].message.tool_calls.length}`);
    realResponse.choices[0].message.tool_calls.forEach((tool, index) => {
      console.log(`    ${index + 1}. ${tool.function?.name || 'unknown'}()`);
    });
  }

  // === RESPONSE ANALYSIS DRY-RUN ===
  console.log('\n🔄 Starting Response Analysis Dry-Run...');

  const { LMStudioCompatibility } = await importFromDist('modules/pipeline/modules/compatibility/lmstudio-compatibility.js');
  const { OpenAIPassthroughLLMSwitch } = await importFromDist('modules/pipeline/modules/llmswitch/openai-passthrough.js');
  const { dryRunPipelineExecutor } = await importFromDist('modules/pipeline/dry-run/dry-run-pipeline-executor.js');
  const { pipelineDryRunManager } = await importFromDist('modules/pipeline/dry-run/pipeline-dry-run-framework.js');

  const logger = {
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    logModule: () => {}
  };
  const errorHandlingCenter = { handleError: async () => {}, createContext: () => ({}) };
  const debugCenter = { processDebugEvent: () => {} };
  const dependencies = { errorHandlingCenter, debugCenter, logger };

  const compatibility = new LMStudioCompatibility({ type: 'lmstudio-compatibility', config: { toolsEnabled: true } }, dependencies);
  const llmSwitch = new OpenAIPassthroughLLMSwitch({ type: 'openai-passthrough', config: {} }, dependencies);

  await compatibility.initialize();
  await llmSwitch.initialize();

  // Create analysis-focused response wrappers
  function createAnalysisWrapper(id, type, underlyingModule) {
    const analysisData = {
      transformationSteps: [],
      inputAnalysis: null,
      outputAnalysis: null,
      performanceMetrics: {},
      errors: []
    };

    return {
      id: `analysis-${id}-${Date.now()}`,
      type: type,
      config: { type, config: {} },

      async initialize() {
        console.log(`🔧 Initializing analysis wrapper for ${id}`);
      },

      async processIncoming(response) {
        const startTime = Date.now();
        console.log(`📥 ${id} starting response analysis...`);

        // Analyze input
        analysisData.inputAnalysis = {
          timestamp: startTime,
          size: JSON.stringify(response).length,
          structure: this.analyzeStructure(response),
          toolCalls: this.extractToolCalls(response),
          choices: response.choices?.length || 0
        };

        let result;
        try {
          // Execute the actual transformation
          if (type === 'compatibility') {
            result = await underlyingModule.processOutgoing(response);
          } else {
            result = await underlyingModule.processOutgoing(response);
          }

          const endTime = Date.now();
          const executionTime = endTime - startTime;

          // Analyze output
          analysisData.outputAnalysis = {
            timestamp: endTime,
            size: JSON.stringify(result).length,
            structure: this.analyzeStructure(result),
            toolCalls: this.extractToolCalls(result),
            choices: result.choices?.length || 0
          };

          // Record transformation
          analysisData.transformationSteps.push({
            step: 'processIncoming',
            startTime,
            endTime,
            executionTime,
            inputSize: analysisData.inputAnalysis.size,
            outputSize: analysisData.outputAnalysis.size,
            sizeChange: analysisData.outputAnalysis.size - analysisData.inputAnalysis.size,
            success: true
          });

          analysisData.performanceMetrics = {
            totalExecutionTime: executionTime,
            throughput: executionTime > 0 ? (analysisData.inputAnalysis.size / executionTime) : 0,
            transformationEfficiency: this.calculateEfficiency(analysisData.inputAnalysis, analysisData.outputAnalysis)
          };

          console.log(`✅ ${id} analysis completed (${executionTime}ms, ${analysisData.inputAnalysis.size}→${analysisData.outputAnalysis.size} bytes)`);
          return result;

        } catch (error) {
          const endTime = Date.now();
          const executionTime = endTime - startTime;

          analysisData.errors.push({
            step: 'processIncoming',
            error: error.message,
            timestamp: endTime,
            executionTime
          });

          analysisData.transformationSteps.push({
            step: 'processIncoming',
            startTime,
            endTime,
            executionTime,
            success: false,
            error: error.message
          });

          console.error(`❌ ${id} analysis failed:`, error.message);
          throw error;
        }
      },

      async processOutgoing(response) {
        return response;
      },

      async cleanup() {
        console.log(`🧹 Cleaning up ${id} analysis wrapper`);
      },

      analyzeStructure(obj) {
        const analyze = (value, depth = 0) => {
          if (depth > 3) return 'max-depth-reached';

          if (value === null) return 'null';
          if (typeof value === 'undefined') return 'undefined';
          if (typeof value === 'string') return 'string';
          if (typeof value === 'number') return 'number';
          if (typeof value === 'boolean') return 'boolean';

          if (Array.isArray(value)) {
            return `array(${value.length})`;
          }

          if (typeof value === 'object') {
            const keys = Object.keys(value);
            return `object(${keys.length}):${keys.join(',')}`;
          }

          return 'unknown';
        };

        return analyze(obj);
      },

      extractToolCalls(response) {
        const toolCalls = [];

        if (response.choices?.[0]?.message?.tool_calls) {
          toolCalls.push(...response.choices[0].message.tool_calls.map(tc => ({
            name: tc.function?.name,
            arguments: tc.function?.arguments
          })));
        }

        return toolCalls;
      },

      calculateEfficiency(input, output) {
        if (input.size === 0) return 0;
        const sizeRatio = output.size / input.size;
        return sizeRatio <= 1 ? sizeRatio : (2 - sizeRatio); // Inverse ratio for growth
      },

      async executeNodeDryRun(request, context) {
        const startTime = Date.now();

        console.log(`🔍 ${id} dry-run analysis started`);
        console.log(`  - Analyzing: ${context.nodeType}`);
        console.log(`  - Input size: ${JSON.stringify(request).length} bytes`);

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
        const totalTime = endTime - startTime;

        const dryRunResult = {
          nodeId: context.nodeId,
          nodeType: context.nodeType,
          status,
          inputData: request,
          expectedOutput: output,
          validationResults: [
            {
              type: 'transformation-analysis',
              passed: status === 'success',
              message: `${id} transformation ${status === 'success' ? 'successful' : 'failed'}`,
              data: analysisData
            }
          ],
          performanceMetrics: {
            estimatedTime: totalTime,
            estimatedMemory: 0,
            complexity: 1,
            analysisData: analysisData
          },
          executionLog: [
            { timestamp: startTime, level: 'info', message: `${id} analysis started` },
            { timestamp: endTime, level: status === 'success' ? 'info' : 'error', message: `${id} analysis ${status}`, data: { time: totalTime, error: error?.message } }
          ],
          metadata: {
            wrapperId: this.id,
            analysisDepth: 'detailed',
            transformationSteps: analysisData.transformationSteps.length,
            errorsDetected: analysisData.errors.length
          }
        };

        console.log(`🎯 ${id} analysis completed (${totalTime}ms, ${analysisData.transformationSteps.length} steps)`);
        return dryRunResult;
      },

      // Provide access to analysis data
      getAnalysisData() {
        return analysisData;
      }
    };
  }

  const compatAnalyzer = createAnalysisWrapper('compatibility', 'compatibility', compatibility);
  const switchAnalyzer = createAnalysisWrapper('llm-switch', 'llm-switch', llmSwitch);

  // Configure response analysis dry-run
  pipelineDryRunManager.clear();
  pipelineDryRunManager.configureNodesDryRun({
    'compatibility-analysis': {
      enabled: true,
      mode: 'full-analysis',
      breakpointBehavior: 'continue',
      verbosity: 'detailed',
      captureExecution: true,
      analyzeTransformations: true
    },
    'llm-switch-analysis': {
      enabled: true,
      mode: 'full-analysis',
      breakpointBehavior: 'continue',
      verbosity: 'detailed',
      captureExecution: true,
      analyzeTransformations: true
    }
  });

  // Register analysis pipeline
  dryRunPipelineExecutor.cleanup();
  dryRunPipelineExecutor.registerNodes([
    { id: 'compatibility-analysis', type: 'compatibility', module: compatAnalyzer, isDryRun: true, config: pipelineDryRunManager.getNodeConfig('compatibility-analysis') },
    { id: 'llm-switch-analysis', type: 'llm-switch', module: switchAnalyzer, isDryRun: true, config: pipelineDryRunManager.getNodeConfig('llm-switch-analysis') }
  ]);
  dryRunPipelineExecutor.setExecutionOrder(['compatibility-analysis', 'llm-switch-analysis']);

  const analysisRequest = {
    data: realResponse,
    route: { providerId: 'lmstudio', modelId: realResponse.model || 'unknown', requestId: `analysis_${Date.now()}`, timestamp: Date.now() },
    metadata: { source: 'analysis', stage: 'response-analysis' },
    debug: { enabled: true, stages: {} }
  };

  console.log('🔬 Executing response analysis pipeline...');
  const analysisResult = await dryRunPipelineExecutor.executePipeline(analysisRequest, 'lmstudio.response-analysis', 'dry-run');

  // === COMPREHENSIVE ANALYSIS REPORT ===
  console.log('\n📊 Generating Comprehensive Analysis Report...');

  const analysisReport = {
    executionSummary: {
      timestamp: new Date().toISOString(),
      responseSource: fs.existsSync(realResponsePath) ? 'file' : 'generated',
      totalAnalysisTime: analysisResult.overallMetrics?.totalExecutionTime || 0,
      nodesAnalyzed: 2,
      analysisDepth: 'detailed'
    },
    originalResponse: {
      id: realResponse.id,
      model: realResponse.model,
      object: realResponse.object,
      choices: realResponse.choices?.length || 0,
      toolCalls: realResponse.choices?.[0]?.message?.tool_calls?.length || 0,
      usage: realResponse.usage || {}
    },
    compatibilityAnalysis: {
      steps: compatAnalyzer.getAnalysisData().transformationSteps,
      inputAnalysis: compatAnalyzer.getAnalysisData().inputAnalysis,
      outputAnalysis: compatAnalyzer.getAnalysisData().outputAnalysis,
      performance: compatAnalyzer.getAnalysisData().performanceMetrics,
      errors: compatAnalyzer.getAnalysisData().errors
    },
    llmSwitchAnalysis: {
      steps: switchAnalyzer.getAnalysisData().transformationSteps,
      inputAnalysis: switchAnalyzer.getAnalysisData().inputAnalysis,
      outputAnalysis: switchAnalyzer.getAnalysisData().outputAnalysis,
      performance: switchAnalyzer.getAnalysisData().performanceMetrics,
      errors: switchAnalyzer.getAnalysisData().errors
    },
    transformationChain: [
      {
        from: 'Raw Provider Response',
        to: 'Compatibility Processed',
        analysis: compatAnalyzer.getAnalysisData()
      },
      {
        from: 'Compatibility Processed',
        to: 'LLM Switch Final',
        analysis: switchAnalyzer.getAnalysisData()
      }
    ],
    insights: {
      totalTransformationTime: (compatAnalyzer.getAnalysisData().performanceMetrics.totalExecutionTime || 0) +
                               (switchAnalyzer.getAnalysisData().performanceMetrics.totalExecutionTime || 0),
      efficiency: {
        compatibility: compatAnalyzer.getAnalysisData().performanceMetrics.transformationEfficiency || 0,
        llmSwitch: switchAnalyzer.getAnalysisData().performanceMetrics.transformationEfficiency || 0,
        overall: ((compatAnalyzer.getAnalysisData().performanceMetrics.transformationEfficiency || 0) +
                  (switchAnalyzer.getAnalysisData().performanceMetrics.transformationEfficiency || 0)) / 2
      },
      errorCount: compatAnalyzer.getAnalysisData().errors.length + switchAnalyzer.getAnalysisData().errors.length,
      sizeChanges: {
        compatibility: (compatAnalyzer.getAnalysisData().outputAnalysis?.size || 0) - (compatAnalyzer.getAnalysisData().inputAnalysis?.size || 0),
        llmSwitch: (switchAnalyzer.getAnalysisData().outputAnalysis?.size || 0) - (switchAnalyzer.getAnalysisData().inputAnalysis?.size || 0)
      }
    }
  };

  // Save analysis reports
  const outDir = path.join(repoRoot, 'tests', 'output');
  writeJSON(path.join(outDir, 'lmstudio-response-analysis-result.json'), analysisResult);
  writeJSON(path.join(outDir, 'lmstudio-response-analysis-report.json'), analysisReport);

  console.log('\n✅ Response Analysis Dry-Run Completed!');
  console.log('📁 Output Files:');
  console.log('  - Analysis result: tests/output/lmstudio-response-analysis-result.json');
  console.log('  - Analysis report: tests/output/lmstudio-response-analysis-report.json');

  // Display key insights
  console.log('\n📈 Key Insights:');
  console.log(`  - Total analysis time: ${analysisReport.insights.totalTransformationTime}ms`);
  console.log(`  - Overall efficiency: ${(analysisReport.insights.efficiency.overall * 100).toFixed(1)}%`);
  console.log(`  - Error count: ${analysisReport.insights.errorCount}`);
  console.log(`  - Size changes: Compatibility ${analysisReport.insights.sizeChanges.compatibility > 0 ? '+' : ''}${analysisReport.insights.sizeChanges.compatibility} bytes, LLM Switch ${analysisReport.insights.sizeChanges.llmSwitch > 0 ? '+' : ''}${analysisReport.insights.sizeChanges.llmSwitch} bytes`);
}

// Support both require and direct node execution
if (process.argv[1] && process.argv[1].endsWith('lmstudio-response-analysis-dry-run.mjs')) {
  main().catch(err => {
    console.error('Failed to run LM Studio response analysis dry-run:', err?.stack || String(err));
    process.exit(1);
  });
}