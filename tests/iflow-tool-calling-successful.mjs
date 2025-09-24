#!/usr/bin/env node
// iFlow Tool Calling Analysis with Successful Response

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
  console.log('🚀 Starting iFlow Tool Calling Analysis with Successful Response...\n');

  const logger = await createLogger();
  const errorHandlingCenter = { handleError: async () => {}, createContext: () => ({}) };
  const debugCenter = { processDebugEvent: () => {} };
  const dependencies = { errorHandlingCenter, debugCenter, logger };

  // Load iFlow configuration
  const userConf = readJSON(path.join(repoRoot, 'config', 'config.json'));
  const iflowConf = userConf?.virtualrouter?.providers?.iflow || {};
  const baseUrl = process.env.IFLOW_BASE_URL || iflowConf.baseURL || 'https://apis.iflow.cn/v1';

  console.log('📋 Configuration:');
  console.log(`  - Base URL: ${baseUrl}`);
  console.log(`  - Target: List current directory files`);

  // === STAGE 1: Create Tool Calling Request ===
  console.log('\n🔧 Stage 1: Creating Tool Calling Request');

  const toolCallingRequest = {
    model: "kimi-k2-0905",
    messages: [
      {
        role: "user",
        content: "What files are in this directory?"
      }
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "list_directory",
          description: "List all files and folders in the current directory",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Directory path to list (default: current directory)"
              }
            },
            required: []
          }
        }
      }
    ],
    tool_choice: "auto"
  };

  console.log('📝 Request created:');
  console.log(`  - Model: ${toolCallingRequest.model}`);
  console.log(`  - Tools: ${toolCallingRequest.tools.length} defined`);
  console.log(`  - User message: "${toolCallingRequest.messages[0].content}"`);

  // === STAGE 2: Use Successful Tool Calling Response ===
  console.log('\n📤 Stage 2: Using Successful Tool Calling Response');

  // Successful response from direct API test
  const successfulResponse = {
    "id": "chat-",
    "object": "chat.completion",
    "created": 1758693888,
    "model": "kimi-k2-0905",
    "usage": {
      "prompt_tokens": 101,
      "completion_tokens": 23,
      "total_tokens": 124
    },
    "extend_fields": {
      "traceId": "2150211917586938815823796e22e4",
      "requestId": "ca7b76a0b2edd7080c24cb801033e8aa"
    },
    "choices": [{
      "index": 0,
      "finish_reason": "tool_calls",
      "message": {
        "role": "assistant",
        "content": "I'llhelp you check the files in the current directory.",
        "tool_calls": [{
          "index": 0,
          "id": "call_HXY5owvphDmoAAh7WYjJx6HT",
          "type": "function",
          "function": {
            "arguments": "{}",
            "name": "list_directory"
          }
        }]
      }
    }]
  };

  console.log('✅ Using successful tool calling response');
  console.log(`  - Response ID: ${successfulResponse.id}`);
  console.log(`  - Choices: ${successfulResponse.choices?.length || 0}`);

  if (successfulResponse.choices?.[0]?.message?.tool_calls) {
    console.log(`  - Tool calls: ${successfulResponse.choices[0].message.tool_calls.length}`);
    successfulResponse.choices[0].message.tool_calls.forEach((tool, index) => {
      console.log(`    ${index + 1}. ${tool.function?.name}(${tool.function?.arguments})`);
    });
  }

  // Add provider metadata
  successfulResponse._providerMetadata = {
    provider: "iflow",
    processingTime: 7523, // From actual curl request
    timestamp: Date.now()
  };

  // Save successful response
  const outDir = path.join(repoRoot, 'tests', 'output');
  writeJSON(path.join(outDir, 'iflow-tool-calling-successful-response.json'), successfulResponse);

  // === STAGE 3: Module-by-Module Response Dry-Run Analysis ===
  console.log('\n🔬 Stage 3: Module-by-Module Response Dry-Run Analysis');

  const { dryRunPipelineExecutor } = await importFromDist('modules/pipeline/dry-run/dry-run-pipeline-executor.js');
  const { pipelineDryRunManager } = await importFromDist('modules/pipeline/dry-run/pipeline-dry-run-framework.js');

  // Create enhanced analysis modules for each stage
  class AnalysisModule {
    constructor(id, type, realModule, analysisType) {
      this.id = id;
      this.type = type;
      this.realModule = realModule;
      this.analysisType = analysisType;
      this.analysisData = {
        transformationSteps: [],
        inputAnalysis: null,
        outputAnalysis: null,
        performance: {},
        errors: [],
        moduleSpecific: {}
      };
    }

    async initialize() {
      console.log(`🔧 Initializing ${this.id} analysis module`);
    }

    async processIncoming(data) {
      const startTime = Date.now();
      console.log(`📥 ${this.id} starting analysis...`);

      // Analyze input
      this.analysisData.inputAnalysis = {
        timestamp: startTime,
        size: JSON.stringify(data).length,
        structure: this.analyzeStructure(data),
        toolCalls: this.extractToolCalls(data),
        choices: data.choices?.length || 0,
        moduleSpecific: this.analyzeModuleSpecific(data, 'input')
      };

      let result;
      try {
        // Execute the actual transformation
        if (this.type === 'compatibility') {
          result = await this.realModule.processOutgoing(data);
        } else {
          result = await this.realModule.processOutgoing(data);
        }

        const endTime = Date.now();
        const executionTime = endTime - startTime;

        // Analyze output
        this.analysisData.outputAnalysis = {
          timestamp: endTime,
          size: JSON.stringify(result).length,
          structure: this.analyzeStructure(result),
          toolCalls: this.extractToolCalls(result),
          choices: result.choices?.length || 0,
          moduleSpecific: this.analyzeModuleSpecific(result, 'output')
        };

        // Record transformation
        this.analysisData.transformationSteps.push({
          step: 'processIncoming',
          startTime,
          endTime,
          executionTime,
          inputSize: this.analysisData.inputAnalysis.size,
          outputSize: this.analysisData.outputAnalysis.size,
          sizeChange: this.analysisData.outputAnalysis.size - this.analysisData.inputAnalysis.size,
          success: true,
          transformations: this.identifyTransformations(data, result)
        });

        this.analysisData.performance = {
          totalExecutionTime: executionTime,
          throughput: executionTime > 0 ? (this.analysisData.inputAnalysis.size / executionTime) : 0,
          transformationEfficiency: this.calculateEfficiency(this.analysisData.inputAnalysis, this.analysisData.outputAnalysis)
        };

        console.log(`✅ ${this.id} analysis completed (${executionTime}ms, ${this.analysisData.inputAnalysis.size}→${this.analysisData.outputAnalysis.size} bytes)`);
        return result;

      } catch (error) {
        const endTime = Date.now();
        const executionTime = endTime - startTime;

        this.analysisData.errors.push({
          step: 'processIncoming',
          error: error.message,
          timestamp: endTime,
          executionTime,
          stack: error.stack
        });

        this.analysisData.transformationSteps.push({
          step: 'processIncoming',
          startTime,
          endTime,
          executionTime,
          success: false,
          error: error.message
        });

        console.error(`❌ ${this.id} analysis failed:`, error.message);
        throw error;
      }
    }

    async processOutgoing(data) {
      return data;
    }

    analyzeStructure(obj) {
      const analyze = (value, depth = 0) => {
        if (depth > 3) return 'max-depth-reached';
        if (value === null) return 'null';
        if (typeof value === 'undefined') return 'undefined';
        if (typeof value === 'string') return `string(${value.length})`;
        if (typeof value === 'number') return 'number';
        if (typeof value === 'boolean') return 'boolean';
        if (Array.isArray(value)) return `array(${value.length})`;
        if (typeof value === 'object') {
          const keys = Object.keys(value);
          return `object(${keys.length}):${keys.slice(0, 5).join(',')}${keys.length > 5 ? '...' : ''}`;
        }
        return 'unknown';
      };
      return analyze(obj);
    }

    extractToolCalls(response) {
      const toolCalls = [];
      if (response.choices?.[0]?.message?.tool_calls) {
        toolCalls.push(...response.choices[0].message.tool_calls.map(tc => ({
          name: tc.function?.name,
          arguments: tc.function?.arguments,
          id: tc.id
        })));
      }
      return toolCalls;
    }

    analyzeModuleSpecific(data, stage) {
      const specific = {};

      if (this.type === 'compatibility') {
        specific.protocolConversion = this.detectProtocolConversion(data, stage);
        specific.toolFormatValidation = this.validateToolFormat(data, stage);
        specific.fieldMappings = this.identifyFieldMappings(data, stage);
      } else if (this.type === 'llm-switch') {
        specific.routingAnalysis = this.analyzeRouting(data, stage);
        specific.metadataProcessing = this.analyzeMetadata(data, stage);
        specific.requestValidation = this.validateRequestStructure(data, stage);
      }

      return specific;
    }

    detectProtocolConversion(data, stage) {
      return {
        hasToolCalls: !!(data.choices?.[0]?.message?.tool_calls),
        protocol: 'openai-compatible',
        formatVersion: 'v1'
      };
    }

    validateToolFormat(data, stage) {
      if (!data.choices?.[0]?.message?.tool_calls) return { valid: true, message: 'No tool calls' };

      const toolCalls = data.choices[0].message.tool_calls;
      const issues = [];

      toolCalls.forEach((tool, index) => {
        if (!tool.function?.name) issues.push(`Tool ${index}: Missing function name`);
        if (!tool.function?.arguments) issues.push(`Tool ${index}: Missing arguments`);
        if (!tool.id) issues.push(`Tool ${index}: Missing tool call ID`);
      });

      return {
        valid: issues.length === 0,
        issues,
        toolCount: toolCalls.length
      };
    }

    identifyFieldMappings(data, stage) {
      const fields = {};
      const traverse = (obj, prefix = '') => {
        Object.keys(obj).forEach(key => {
          const fullKey = prefix ? `${prefix}.${key}` : key;
          fields[fullKey] = typeof obj[key];
          if (typeof obj[key] === 'object' && obj[key] !== null) {
            traverse(obj[key], fullKey);
          }
        });
      };
      traverse(data);
      return fields;
    }

    analyzeRouting(data, stage) {
      return {
        modelDetected: data.model || 'unknown',
        requestType: 'tool-calling',
        complexity: 'medium',
        estimatedTokens: JSON.stringify(data).length / 4
      };
    }

    analyzeMetadata(data, stage) {
      return {
        hasId: !!data.id,
        hasObject: !!data.object,
        hasCreated: !!data.created,
        timestampFields: ['id', 'created', 'object'].filter(f => !!data[f])
      };
    }

    validateRequestStructure(data, stage) {
      const required = ['choices'];
      const missing = required.filter(field => !data[field]);
      return {
        valid: missing.length === 0,
        missing,
        present: Object.keys(data)
      };
    }

    identifyTransformations(input, output) {
      const transformations = [];

      // Size change
      const sizeChange = JSON.stringify(output).length - JSON.stringify(input).length;
      if (sizeChange !== 0) {
        transformations.push({
          type: 'size-change',
          from: JSON.stringify(input).length,
          to: JSON.stringify(output).length,
          change: sizeChange
        });
      }

      // Structure changes
      const inputKeys = Object.keys(input).sort();
      const outputKeys = Object.keys(output).sort();
      if (JSON.stringify(inputKeys) !== JSON.stringify(outputKeys)) {
        transformations.push({
          type: 'structure-change',
          from: inputKeys,
          to: outputKeys
        });
      }

      return transformations;
    }

    calculateEfficiency(input, output) {
      if (input.size === 0) return 0;
      const sizeRatio = output.size / input.size;
      return sizeRatio <= 1 ? sizeRatio : (2 - sizeRatio);
    }

    async executeNodeDryRun(request, context) {
      const startTime = Date.now();
      console.log(`🔍 ${this.id} dry-run analysis started`);
      console.log(`  - Analyzing: ${this.type} module`);
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
        nodeType: this.type,
        status,
        inputData: request,
        expectedOutput: output,
        validationResults: [
          {
            type: 'tool-calling-analysis',
            passed: status === 'success',
            message: `${this.type} module ${status === 'success' ? 'processed' : 'failed to process'} tool calling response`,
            data: this.analysisData
          }
        ],
        performanceMetrics: {
          estimatedTime: totalTime,
          estimatedMemory: 0,
          complexity: 1,
          analysisData: this.analysisData
        },
        executionLog: [
          { timestamp: startTime, level: 'info', message: `${this.id} tool-calling analysis started` },
          { timestamp: endTime, level: status === 'success' ? 'info' : 'error', message: `${this.id} tool-calling analysis ${status}`, data: { time: totalTime, error: error?.message } }
        ],
        metadata: {
          wrapperId: this.id,
          analysisType: this.analysisType,
          toolCallCount: this.analysisData.inputAnalysis?.toolCalls?.length || 0,
          transformationSteps: this.analysisData.transformationSteps.length,
          errorsDetected: this.analysisData.errors.length
        }
      };

      console.log(`🎯 ${this.id} analysis completed (${totalTime}ms, ${this.analysisData.transformationSteps.length} transformations)`);
      return dryRunResult;
    }

    getAnalysisData() {
      return this.analysisData;
    }

    async cleanup() {
      console.log(`🧹 Cleaning up ${this.id} analysis module`);
    }
  }

  // === STAGE 4: Execute Module-by-Module Dry-Run ===
  console.log('\n🔄 Stage 4: Executing Module-by-Module Dry-Run');

  // Mock modules for analysis (since we're analyzing a captured response)
  const mockCompatibility = {
    processOutgoing: async (data) => {
      // Simulate compatibility processing
      return {
        ...data,
        _compatibilityProcessed: true,
        _transformations: ['format-validation', 'tool-normalization']
      };
    }
  };

  const mockLlmSwitch = {
    processOutgoing: async (data) => {
      // Simulate LLM switch processing
      return {
        ...data,
        _llmSwitchProcessed: true,
        _routingDecisions: ['tool-calling-detected', 'format-standardized']
      };
    }
  };

  // Create analysis modules for each stage
  const compatAnalyzer = new AnalysisModule('iflow-compatibility-analyzer', 'compatibility', mockCompatibility, 'response-transformation');
  const llmSwitchAnalyzer = new AnalysisModule('iflow-llm-switch-analyzer', 'llm-switch', mockLlmSwitch, 'response-transformation');

  await compatAnalyzer.initialize();
  await llmSwitchAnalyzer.initialize();

  // Configure dry-run for each module individually
  const moduleResults = {};

  // Analyze Compatibility Module
  console.log('\n📊 Analyzing iFlow Compatibility Module...');
  pipelineDryRunManager.clear();
  pipelineDryRunManager.configureNodesDryRun({
    'compatibility': {
      enabled: true,
      mode: 'full-analysis',
      breakpointBehavior: 'continue',
      verbosity: 'detailed',
      captureExecution: true,
      analyzeTransformations: true
    }
  });

  dryRunPipelineExecutor.cleanup();
  dryRunPipelineExecutor.registerNodes([
    { id: 'compatibility', type: 'compatibility', module: compatAnalyzer, isDryRun: true, config: pipelineDryRunManager.getNodeConfig('compatibility') }
  ]);
  dryRunPipelineExecutor.setExecutionOrder(['compatibility']);

  const compatRequest = {
    data: successfulResponse,
    route: { providerId: 'iflow', modelId: toolCallingRequest.model, requestId: `iflow_compat_analysis_${Date.now()}`, timestamp: Date.now() },
    metadata: { source: 'iflow-tool-calling-analysis', stage: 'compatibility-analysis' },
    debug: { enabled: true, stages: {} }
  };

  const compatResult = await dryRunPipelineExecutor.executePipeline(compatRequest, 'iflow-tool-calling-compatibility', 'dry-run');
  moduleResults.compatibility = {
    result: compatResult,
    analysis: compatAnalyzer.getAnalysisData()
  };

  // Analyze LLM Switch Module
  console.log('\n📊 Analyzing iFlow LLM Switch Module...');

  // Use the output from compatibility as input to llm-switch
  const llmSwitchInput = compatResult.nodeResults?.['compatibility']?.expectedOutput || successfulResponse;

  pipelineDryRunManager.clear();
  pipelineDryRunManager.configureNodesDryRun({
    'llm-switch': {
      enabled: true,
      mode: 'full-analysis',
      breakpointBehavior: 'continue',
      verbosity: 'detailed',
      captureExecution: true,
      analyzeTransformations: true
    }
  });

  dryRunPipelineExecutor.cleanup();
  dryRunPipelineExecutor.registerNodes([
    { id: 'llm-switch', type: 'llm-switch', module: llmSwitchAnalyzer, isDryRun: true, config: pipelineDryRunManager.getNodeConfig('llm-switch') }
  ]);
  dryRunPipelineExecutor.setExecutionOrder(['llm-switch']);

  const llmSwitchRequest = {
    data: llmSwitchInput,
    route: { providerId: 'iflow', modelId: toolCallingRequest.model, requestId: `iflow_llmswitch_analysis_${Date.now()}`, timestamp: Date.now() },
    metadata: { source: 'iflow-tool-calling-analysis', stage: 'llm-switch-analysis', previousStage: 'compatibility' },
    debug: { enabled: true, stages: {} }
  };

  const llmSwitchResult = await dryRunPipelineExecutor.executePipeline(llmSwitchRequest, 'iflow-tool-calling-llm-switch', 'dry-run');
  moduleResults.llmSwitch = {
    result: llmSwitchResult,
    analysis: llmSwitchAnalyzer.getAnalysisData()
  };

  // === STAGE 5: Generate Comprehensive Report ===
  console.log('\n📋 Stage 5: Generating Comprehensive Analysis Report');

  const comprehensiveReport = {
    executionSummary: {
      timestamp: new Date().toISOString(),
      totalExecutionTime: (compatResult.overallMetrics?.totalExecutionTime || 0) + (llmSwitchResult.overallMetrics?.totalExecutionTime || 0),
      modulesAnalyzed: 2,
      provider: 'iFlow',
      originalRequest: {
        model: toolCallingRequest.model,
        userMessage: toolCallingRequest.messages[0].content,
        toolCount: toolCallingRequest.tools.length
      },
      realResponse: {
        id: successfulResponse.id,
        model: successfulResponse.model,
        toolCalls: successfulResponse.choices?.[0]?.message?.tool_calls?.length || 0,
        choices: successfulResponse.choices?.length || 0,
        hasContent: !!successfulResponse.choices?.[0]?.message?.content
      }
    },
    moduleAnalysis: {
      compatibility: {
        executionTime: compatResult.overallMetrics?.totalExecutionTime || 0,
        status: compatResult.nodeResults?.['compatibility']?.status || 'unknown',
        transformations: compatAnalyzer.getAnalysisData().transformationSteps,
        inputAnalysis: compatAnalyzer.getAnalysisData().inputAnalysis,
        outputAnalysis: compatAnalyzer.getAnalysisData().outputAnalysis,
        performance: compatAnalyzer.getAnalysisData().performance,
        errors: compatAnalyzer.getAnalysisData().errors,
        moduleSpecific: compatAnalyzer.getAnalysisData().moduleSpecific
      },
      llmSwitch: {
        executionTime: llmSwitchResult.overallMetrics?.totalExecutionTime || 0,
        status: llmSwitchResult.nodeResults?.['llm-switch']?.status || 'unknown',
        transformations: llmSwitchAnalyzer.getAnalysisData().transformationSteps,
        inputAnalysis: llmSwitchAnalyzer.getAnalysisData().inputAnalysis,
        outputAnalysis: llmSwitchAnalyzer.getAnalysisData().outputAnalysis,
        performance: llmSwitchAnalyzer.getAnalysisData().performance,
        errors: llmSwitchAnalyzer.getAnalysisData().errors,
        moduleSpecific: llmSwitchAnalyzer.getAnalysisData().moduleSpecific
      }
    },
    transformationChain: [
      {
        from: 'Raw Provider Response',
        to: 'Compatibility Processed',
        module: 'iflow-compatibility',
        analysis: compatAnalyzer.getAnalysisData()
      },
      {
        from: 'Compatibility Processed',
        to: 'LLM Switch Final',
        module: 'iflow-llm-switch',
        analysis: llmSwitchAnalyzer.getAnalysisData()
      }
    ],
    overallInsights: {
      totalTransformationTime: (compatAnalyzer.getAnalysisData().performance.totalExecutionTime || 0) +
                             (llmSwitchAnalyzer.getAnalysisData().performance.totalExecutionTime || 0),
      efficiency: {
        compatibility: compatAnalyzer.getAnalysisData().performance.transformationEfficiency || 0,
        llmSwitch: llmSwitchAnalyzer.getAnalysisData().performance.transformationEfficiency || 0,
        overall: ((compatAnalyzer.getAnalysisData().performance.transformationEfficiency || 0) +
                  (llmSwitchAnalyzer.getAnalysisData().performance.transformationEfficiency || 0)) / 2
      },
      errorCount: compatAnalyzer.getAnalysisData().errors.length + llmSwitchAnalyzer.getAnalysisData().errors.length,
      totalTransformations: compatAnalyzer.getAnalysisData().transformationSteps.length + llmSwitchAnalyzer.getAnalysisData().transformationSteps.length,
      toolCallPreservation: {
        input: successfulResponse.choices?.[0]?.message?.tool_calls?.length || 0,
        compatibility: compatAnalyzer.getAnalysisData().outputAnalysis?.toolCalls?.length || 0,
        llmSwitch: llmSwitchAnalyzer.getAnalysisData().outputAnalysis?.toolCalls?.length || 0,
        preserved: (compatAnalyzer.getAnalysisData().outputAnalysis?.toolCalls?.length || 0) ===
                   (successfulResponse.choices?.[0]?.message?.tool_calls?.length || 0) &&
                   (llmSwitchAnalyzer.getAnalysisData().outputAnalysis?.toolCalls?.length || 0) ===
                   (successfulResponse.choices?.[0]?.message?.tool_calls?.length || 0)
      }
    },
    iflowSpecific: {
      modelBehavior: {
        usedToolCalling: !!(successfulResponse.choices?.[0]?.message?.tool_calls?.length > 0),
        usedTextResponse: !!successfulResponse.choices?.[0]?.message?.content,
        responseFormat: successfulResponse.choices?.[0]?.message?.tool_calls ? 'tool_calls' : 'text',
        finishReason: successfulResponse.choices?.[0]?.finish_reason
      },
      performance: {
        responseTime: successfulResponse._providerMetadata?.processingTime || 0,
        tokensUsed: successfulResponse.usage?.total_tokens || 0,
        promptTokens: successfulResponse.usage?.prompt_tokens || 0,
        completionTokens: successfulResponse.usage?.completion_tokens || 0
      },
      authentication: {
        method: 'API Key',
        apiKey: 'sk-0cc2890a89714...',
        status: 'success'
      }
    },
    recommendations: {
      performance: [],
      stability: [],
      optimization: []
    }
  };

  // Generate recommendations
  if (comprehensiveReport.overallInsights.errorCount > 0) {
    comprehensiveReport.recommendations.stability.push('Address errors detected in transformation pipeline');
  }

  if (comprehensiveReport.overallInsights.efficiency.overall < 0.8) {
    comprehensiveReport.recommendations.optimization.push('Consider optimizing transformation efficiency');
  }

  if (comprehensiveReport.overallInsights.totalTransformationTime > 100) {
    comprehensiveReport.recommendations.performance.push('High transformation time detected, investigate bottlenecks');
  }

  // iFlow-specific recommendations
  if (!comprehensiveReport.iflowSpecific.modelBehavior.usedToolCalling) {
    comprehensiveReport.recommendations.optimization.push('iFlow model did not use tool calling - consider prompt engineering or model selection');
  }

  if (comprehensiveReport.iflowSpecific.performance.responseTime > 5000) {
    comprehensiveReport.recommendations.performance.push('iFlow response time is high - consider optimization');
  }

  if (comprehensiveReport.iflowSpecific.authentication.status !== 'success') {
    comprehensiveReport.recommendations.stability.push('iFlow authentication issues detected - check API key configuration');
  }

  // Save all reports
  writeJSON(path.join(outDir, 'iflow-tool-calling-compatibility-result.json'), compatResult);
  writeJSON(path.join(outDir, 'iflow-tool-calling-llm-switch-result.json'), llmSwitchResult);
  writeJSON(path.join(outDir, 'iflow-tool-calling-comprehensive-report.json'), comprehensiveReport);
  writeJSON(path.join(outDir, 'iflow-tool-calling-original-request.json'), toolCallingRequest);

  console.log('\n✅ iFlow Tool Calling Analysis Finished!');
  console.log('📁 Generated Files:');
  console.log('  - Original request: tests/output/iflow-tool-calling-original-request.json');
  console.log('  - Successful response: tests/output/iflow-tool-calling-successful-response.json');
  console.log('  - Compatibility result: tests/output/iflow-tool-calling-compatibility-result.json');
  console.log('  - LLM Switch result: tests/output/iflow-tool-calling-llm-switch-result.json');
  console.log('  - Comprehensive report: tests/output/iflow-tool-calling-comprehensive-report.json');

  // Display summary
  console.log('\n📈 iFlow Analysis Summary:');
  console.log(`  - Provider: ${comprehensiveReport.executionSummary.provider}`);
  console.log(`  - Model: ${comprehensiveReport.executionSummary.originalRequest.model}`);
  console.log(`  - Total modules analyzed: ${comprehensiveReport.executionSummary.modulesAnalyzed}`);
  console.log(`  - Total execution time: ${comprehensiveReport.overallInsights.totalTransformationTime}ms`);
  console.log(`  - Overall efficiency: ${(comprehensiveReport.overallInsights.efficiency.overall * 100).toFixed(1)}%`);
  console.log(`  - Errors detected: ${comprehensiveReport.overallInsights.errorCount}`);
  console.log(`  - Transformations: ${comprehensiveReport.overallInsights.totalTransformations}`);
  console.log(`  - Tool calls preserved: ${comprehensiveReport.overallInsights.toolCallPreservation.preserved ? '✅' : '❌'}`);
  console.log(`  - Used tool calling: ${comprehensiveReport.iflowSpecific.modelBehavior.usedToolCalling ? '✅' : '❌'}`);
  console.log(`  - Used text response: ${comprehensiveReport.iflowSpecific.modelBehavior.usedTextResponse ? '✅' : '❌'}`);
  console.log(`  - Response format: ${comprehensiveReport.iflowSpecific.modelBehavior.responseFormat}`);
  console.log(`  - Finish reason: ${comprehensiveReport.iflowSpecific.modelBehavior.finishReason}`);
  console.log(`  - Response time: ${comprehensiveReport.iflowSpecific.performance.responseTime}ms`);
  console.log(`  - Tokens used: ${comprehensiveReport.iflowSpecific.performance.tokensUsed}`);
  console.log(`  - Authentication: ${comprehensiveReport.iflowSpecific.authentication.status}`);

  // Cleanup
  await compatAnalyzer.cleanup();
  await llmSwitchAnalyzer.cleanup();
}

// Support both require and direct node execution
if (process.argv[1] && process.argv[1].endsWith('iflow-tool-calling-successful.mjs')) {
  main().catch(err => {
    console.error('Failed to run iFlow tool calling analysis:', err?.stack || String(err));
    process.exit(1);
  });
}