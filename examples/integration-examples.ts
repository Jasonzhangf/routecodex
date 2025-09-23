/**
 * RouteCodex Module Enhancement Integration Examples
 *
 * This file demonstrates how to enhance existing modules with debugging capabilities
 * using the progressive enhancement system.
 */

import { ModuleEnhancementFactory, EnhancementConfig } from '../src/modules/enhancement/module-enhancement-factory.js';
import { EnhancementConfigManager } from '../src/modules/enhancement/enhancement-config-manager.js';
import { DebugCenter } from 'rcc-debugcenter';

// Mock DebugCenter for examples
class MockDebugCenter {
  async processDebugEvent(event: any) {
    console.log('DebugCenter Event:', event);
  }
}

/**
 * Example 1: Enhancing an LM Studio Provider Module
 */
export async function example1_EnhanceLMStudioProvider() {
  console.log('=== Example 1: Enhancing LM Studio Provider ===');

  // Create debug center
  const debugCenter = new MockDebugCenter();

  // Create enhancement factory
  const factory = new ModuleEnhancementFactory(debugCenter);

  // Original LM Studio Provider (simplified for example)
  class LMStudioProvider {
    readonly id = 'lmstudio-provider-123';
    readonly type = 'lmstudio-http';
    readonly providerType = 'lmstudio';

    private isInitialized = false;
    private baseUrl = 'http://localhost:1234';

    constructor(private config: any) {}

    async initialize(): Promise<void> {
      console.log('Initializing LM Studio Provider...');
      this.isInitialized = true;
    }

    async processIncoming(request: any): Promise<any> {
      if (!this.isInitialized) {
        throw new Error('Provider not initialized');
      }

      console.log('Processing request...');
      // Simulate processing
      await new Promise(resolve => setTimeout(resolve, 100));

      return {
        data: { id: 'response-123', choices: [{ message: { content: 'Hello from LM Studio' } }] },
        status: 200,
        metadata: { processingTime: 100 }
      };
    }

    async cleanup(): Promise<void> {
      console.log('Cleaning up LM Studio Provider...');
      this.isInitialized = false;
    }

    getStatus() {
      return {
        id: this.id,
        type: this.type,
        isInitialized: this.isInitialized,
        baseUrl: this.baseUrl
      };
    }
  }

  // Create original module
  const originalProvider = new LMStudioProvider({
    baseUrl: 'http://localhost:1234',
    auth: { type: 'apikey', apiKey: 'test-key' }
  });

  // Enhancement configuration
  const enhancementConfig: EnhancementConfig = {
    enabled: true,
    level: 'verbose',
    consoleLogging: true,
    debugCenter: true,
    maxLogEntries: 1000,
    performanceTracking: true,
    requestLogging: true,
    errorTracking: true,
    transformationLogging: false
  };

  // Create enhanced module
  const enhanced = factory.createEnhancedModule(
    originalProvider,
    'lmstudio-provider',
    'provider',
    enhancementConfig
  );

  console.log('Enhanced module created:', enhanced.metadata);

  // Use the enhanced module
  try {
    await enhanced.enhanced.initialize();

    const response = await enhanced.enhanced.processIncoming({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Hello' }]
    });

    console.log('Response received:', response);

    // Get debug logs
    const logs = enhanced.logger.getRecentLogs(10);
    console.log('Debug logs:', logs.length, 'entries');

  } finally {
    await enhanced.enhanced.cleanup();
  }
}

/**
 * Example 2: Configuration-Driven Enhancement
 */
export async function example2_ConfigurationDrivenEnhancement() {
  console.log('\\n=== Example 2: Configuration-Driven Enhancement ===');

  // Create debug center
  const debugCenter = new MockDebugCenter();

  // Create configuration manager
  const configManager = new EnhancementConfigManager(debugCenter);

  // Original Pipeline Manager (simplified for example)
  class PipelineManager {
    readonly id = 'pipeline-manager';
    readonly type = 'manager';

    private isInitialized = false;
    private pipelines = new Map();

    constructor(private config: any) {}

    async initialize(): Promise<void> {
      console.log('Initializing Pipeline Manager...');
      this.isInitialized = true;
    }

    async processRequest(request: any): Promise<any> {
      if (!this.isInitialized) {
        throw new Error('Pipeline Manager not initialized');
      }

      console.log('Processing pipeline request...');
      // Simulate processing
      await new Promise(resolve => setTimeout(resolve, 50));

      return {
        route: request.route,
        metadata: { processingTime: 50 }
      };
    }

    getStatus() {
      return {
        id: this.id,
        type: this.type,
        isInitialized: this.isInitialized,
        pipelineCount: this.pipelines.size
      };
    }
  }

  // Create original module
  const originalManager = new PipelineManager({
    pipelines: [
      { id: 'test-pipeline', provider: { type: 'lmstudio' }, modules: {} }
    ]
  });

  // Enhance using configuration manager
  const enhanced = await configManager.enhanceModule(
    originalManager,
    'pipeline-manager',
    'pipeline'
  );

  console.log('Configuration-driven enhancement:', enhanced.metadata);

  // Use the enhanced module
  try {
    await enhanced.enhanced.initialize();

    const response = await enhanced.enhanced.processRequest({
      route: {
        providerId: 'lmstudio',
        modelId: 'test-model',
        requestId: 'req-123'
      }
    });

    console.log('Pipeline response:', response);

    // Get statistics
    const stats = enhanced.logger.getStatistics();
    console.log('Statistics:', stats);

  } finally {
    await enhanced.enhanced.cleanup();
  }
}

/**
 * Example 3: Progressive Enhancement - Adding Debugging to Existing Module
 */
export async function example3_ProgressiveEnhancement() {
  console.log('\\n=== Example 3: Progressive Enhancement ===');

  // This example shows how to gradually add debugging to an existing module
  // while maintaining backward compatibility

  class ExistingCompatibilityModule {
    readonly id = 'compatibility-module';
    readonly type = 'compatibility';

    private isInitialized = false;

    async initialize(): Promise<void> {
      console.log('Initializing compatibility module...');
      this.isInitialized = true;
    }

    async processIncoming(request: any): Promise<any> {
      if (!this.isInitialized) {
        throw new Error('Module not initialized');
      }

      console.log('Transforming request...');
      // Simulate transformation
      const transformed = {
        ...request,
        _transformed: true,
        _timestamp: Date.now()
      };

      return transformed;
    }

    async processOutgoing(response: any): Promise<any> {
      console.log('Transforming response...');
      // Simulate reverse transformation
      const original = {
        ...response,
        _restored: true
      };

      return original;
    }

    getStatus() {
      return {
        id: this.id,
        type: this.type,
        isInitialized: this.isInitialized
      };
    }
  }

  // Create the existing module
  const existingModule = new ExistingCompatibilityModule();

  // Step 1: Use the module as-is (before enhancement)
  console.log('Step 1: Using existing module without enhancement');
  await existingModule.initialize();
  const originalResponse = await existingModule.processIncoming({
    model: 'test-model',
    messages: [{ role: 'user', content: 'Hello' }]
  });
  console.log('Original response:', originalResponse);

  // Step 2: Create enhanced version (progressive enhancement)
  console.log('\\nStep 2: Creating enhanced version');
  const debugCenter = new MockDebugCenter();
  const factory = new ModuleEnhancementFactory(debugCenter);

  const enhanced = factory.createEnhancedModule(
    existingModule,
    'compatibility-module',
    'compatibility',
    {
      enabled: true,
      level: 'detailed',
      consoleLogging: true,
      debugCenter: true,
      performanceTracking: true,
      transformationLogging: true
    }
  );

  console.log('Enhanced module created');

  // Step 3: Use enhanced module
  console.log('\\nStep 3: Using enhanced module');
  const enhancedResponse = await enhanced.enhanced.processIncoming({
    model: 'test-model',
    messages: [{ role: 'user', content: 'Hello' }]
  });
  console.log('Enhanced response:', enhancedResponse);

  // Step 4: Compare performance and logs
  console.log('\\nStep 4: Analyzing debug information');
  const stats = enhanced.logger.getStatistics();
  console.log('Enhancement statistics:', stats);

  const recentLogs = enhanced.logger.getRecentLogs(5);
  console.log('Recent logs:', recentLogs.length, 'entries');
  recentLogs.forEach(log => {
    console.log(`  [${log.level}] ${log.category}: ${log.message}`);
  });

  // Cleanup
  await enhanced.enhanced.cleanup();
}

/**
 * Example 4: Batch Enhancement of Multiple Modules
 */
export async function example4_BatchEnhancement() {
  console.log('\\n=== Example 4: Batch Enhancement ===');

  // Create multiple modules to enhance
  const modules = [
    {
      id: 'provider-1',
      type: 'provider',
      instance: createMockProvider('provider-1')
    },
    {
      id: 'provider-2',
      type: 'provider',
      instance: createMockProvider('provider-2')
    },
    {
      id: 'compatibility-1',
      type: 'compatibility',
      instance: createMockCompatibility('compatibility-1')
    },
    {
      id: 'workflow-1',
      type: 'workflow',
      instance: createMockWorkflow('workflow-1')
    }
  ];

  // Create debug center and factory
  const debugCenter = new MockDebugCenter();
  const factory = new ModuleEnhancementFactory(debugCenter);

  // Enhance all modules
  const enhancedModules = new Map();

  for (const module of modules) {
    console.log(`Enhancing ${module.id}...`);

    const enhanced = factory.createEnhancedModule(
      module.instance,
      module.id,
      module.type,
      {
        enabled: true,
        level: 'detailed',
        consoleLogging: true,
        debugCenter: true,
        performanceTracking: true
      }
    );

    enhancedModules.set(module.id, enhanced);
  }

  console.log('All modules enhanced');

  // Use enhanced modules
  console.log('\\nTesting enhanced modules:');
  for (const [id, enhanced] of enhancedModules) {
    console.log(`\\nTesting ${id}:`);

    try {
      await enhanced.enhanced.initialize();

      // Test processing
      const result = await enhanced.enhanced.processIncoming({
        test: true,
        moduleId: id
      });

      console.log(`  ✓ Processed successfully`);
      console.log(`  Logs: ${enhanced.logger.getStatistics().totalLogs} entries`);

    } catch (error) {
      console.log(`  ✗ Error: ${error.message}`);
    } finally {
      await enhanced.enhanced.cleanup();
    }
  }

  // Summary
  console.log('\\nBatch enhancement summary:');
  const allStats = Array.from(enhancedModules.values()).map(m => ({
    id: m.metadata.moduleId,
    type: m.metadata.moduleType,
    enhanced: m.metadata.enhanced,
    logs: m.logger.getStatistics()
  }));

  console.table(allStats);
}

/**
 * Example 5: Selective Enhancement Based on Environment
 */
export async function example5_EnvironmentBasedEnhancement() {
  console.log('\\n=== Example 5: Environment-Based Enhancement ===');

  // Create debug center
  const debugCenter = new MockDebugCenter();
  const factory = new ModuleEnhancementFactory(debugCenter);

  // Create a module
  const module = createMockProvider('env-aware-provider');

  // Determine enhancement configuration based on environment
  const env = process.env.NODE_ENV || 'development';
  console.log(`Current environment: ${env}`);

  let config: EnhancementConfig;

  switch (env) {
    case 'production':
      config = {
        enabled: false, // Disabled in production for performance
        level: 'basic',
        consoleLogging: false,
        debugCenter: true, // Still send to DebugCenter for monitoring
        maxLogEntries: 100,
        performanceTracking: true,
        errorTracking: true
      };
      break;

    case 'test':
      config = {
        enabled: true,
        level: 'verbose',
        consoleLogging: true,
        debugCenter: true,
        maxLogEntries: 5000,
        performanceTracking: true,
        requestLogging: true,
        errorTracking: true,
        transformationLogging: true
      };
      break;

    case 'development':
    default:
      config = {
        enabled: true,
        level: 'detailed',
        consoleLogging: true,
        debugCenter: true,
        maxLogEntries: 1000,
        performanceTracking: true,
        requestLogging: true,
        errorTracking: true,
        transformationLogging: true
      };
      break;
  }

  console.log('Enhancement config:', config);

  // Create enhanced module
  const enhanced = factory.createEnhancedModule(
    module,
    'env-aware-provider',
    'provider',
    config
  );

  console.log('Environment-aware enhancement:', enhanced.metadata);

  // Test the enhanced module
  try {
    await enhanced.enhanced.initialize();

    const response = await enhanced.enhanced.processIncoming({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Hello' }]
    });

    console.log('Response received');
    console.log('Is enhanced:', enhanced.metadata.enhanced);
    console.log('Debug level:', config.level);

  } finally {
    await enhanced.enhanced.cleanup();
  }
}

// Helper functions to create mock modules
function createMockProvider(id: string) {
  return {
    id,
    type: 'provider',
    providerType: 'mock',
    isInitialized: false,

    async initialize() {
      console.log(`Provider ${id} initializing...`);
      this.isInitialized = true;
    },

    async processIncoming(request: any) {
      if (!this.isInitialized) {
        throw new Error('Provider not initialized');
      }

      await new Promise(resolve => setTimeout(resolve, 50));

      return {
        data: { id: `resp-${Date.now()}`, choices: [{ message: { content: `Mock response from ${id}` } }] },
        status: 200,
        metadata: { processingTime: 50 }
      };
    },

    async processOutgoing(response: any) {
      return response;
    },

    async cleanup() {
      console.log(`Provider ${id} cleaning up...`);
      this.isInitialized = false;
    },

    getStatus() {
      return {
        id: this.id,
        type: this.type,
        isInitialized: this.isInitialized
      };
    }
  };
}

function createMockCompatibility(id: string) {
  return {
    id,
    type: 'compatibility',
    isInitialized: false,

    async initialize() {
      console.log(`Compatibility ${id} initializing...`);
      this.isInitialized = true;
    },

    async processIncoming(request: any) {
      if (!this.isInitialized) {
        throw new Error('Module not initialized');
      }

      await new Promise(resolve => setTimeout(resolve, 25));

      return {
        ...request,
        _transformedBy: id,
        _timestamp: Date.now()
      };
    },

    async processOutgoing(response: any) {
      return response;
    },

    async cleanup() {
      console.log(`Compatibility ${id} cleaning up...`);
      this.isInitialized = false;
    },

    getStatus() {
      return {
        id: this.id,
        type: this.type,
        isInitialized: this.isInitialized
      };
    }
  };
}

function createMockWorkflow(id: string) {
  return {
    id,
    type: 'workflow',
    isInitialized: false,

    async initialize() {
      console.log(`Workflow ${id} initializing...`);
      this.isInitialized = true;
    },

    async execute(context: any) {
      if (!this.isInitialized) {
        throw new Error('Workflow not initialized');
      }

      await new Promise(resolve => setTimeout(resolve, 75));

      return {
        ...context,
        _processedBy: id,
        _workflowComplete: true
      };
    },

    async processIncoming(request: any) {
      return this.execute(request);
    },

    async processOutgoing(response: any) {
      return response;
    },

    async cleanup() {
      console.log(`Workflow ${id} cleaning up...`);
      this.isInitialized = false;
    },

    getStatus() {
      return {
        id: this.id,
        type: this.type,
        isInitialized: this.isInitialized
      };
    }
  };
}

// Run all examples
export async function runAllExamples() {
  try {
    await example1_EnhanceLMStudioProvider();
    await example2_ConfigurationDrivenEnhancement();
    await example3_ProgressiveEnhancement();
    await example4_BatchEnhancement();
    await example5_EnvironmentBasedEnhancement();

    console.log('\\n🎉 All examples completed successfully!');
  } catch (error) {
    console.error('Example failed:', error);
  }
}

// Export for use
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllExamples();
}