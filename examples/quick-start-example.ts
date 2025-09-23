/**
 * Quick Start Example - Progressive Module Enhancement
 *
 * This example demonstrates the simplest way to add debugging capabilities
 * to an existing module using the enhancement system.
 */

import { ModuleEnhancementFactory } from '../src/modules/enhancement/module-enhancement-factory.js';

// Mock DebugCenter for the example
class MockDebugCenter {
  async processDebugEvent(event: any) {
    console.log('🔍 Debug Event:', {
      ...event,
      data: typeof event.data === 'object' ? JSON.stringify(event.data, null, 2) : event.data
    });
  }
}

/**
 * Example: Enhancing a Simple Provider Module
 */
export async function quickStartExample() {
  console.log('🚀 Quick Start: Module Enhancement Example');
  console.log('='.repeat(50));

  // 1. Create your original module (no changes needed!)
  class SimpleProvider {
    readonly id = 'simple-provider-123';
    readonly type = 'simple-provider';

    private isInitialized = false;

    async initialize(): Promise<void> {
      console.log('📦 Initializing simple provider...');
      await new Promise(resolve => setTimeout(resolve, 100));
      this.isInitialized = true;
      console.log('✅ Simple provider initialized');
    }

    async processIncoming(request: any): Promise<any> {
      if (!this.isInitialized) {
        throw new Error('Provider not initialized');
      }

      console.log('🔄 Processing request...');

      // Simulate some work
      await new Promise(resolve => setTimeout(resolve, 150));

      const response = {
        id: `resp-${Date.now()}`,
        data: {
          choices: [{
            message: {
              content: `Hello from ${request.messages[0].content}!`
            }
          }]
        },
        metadata: {
          processingTime: 150,
          model: request.model
        }
      };

      console.log('✅ Request processed');
      return response;
    }

    async cleanup(): Promise<void> {
      console.log('🧹 Cleaning up simple provider...');
      this.isInitialized = false;
      console.log('✅ Cleanup complete');
    }

    getStatus() {
      return {
        id: this.id,
        type: this.type,
        isInitialized: this.isInitialized,
        uptime: Date.now()
      };
    }
  }

  // 2. Create the enhancement factory
  const debugCenter = new MockDebugCenter();
  const factory = new ModuleEnhancementFactory(debugCenter);

  // 3. Create your original module
  const originalProvider = new SimpleProvider();

  // 4. Enhance it with debugging (just one line!)
  const enhanced = factory.createEnhancedModule(
    originalProvider,
    'simple-provider',
    'provider',
    {
      enabled: true,
      level: 'detailed',
      consoleLogging: true,
      debugCenter: true,
      performanceTracking: true,
      requestLogging: true,
      errorTracking: true
    }
  );

  console.log('\\n🎯 Enhancement Summary:');
  console.log(`   Module ID: ${enhanced.metadata.moduleId}`);
  console.log(`   Module Type: ${enhanced.metadata.moduleType}`);
  console.log(`   Enhanced: ${enhanced.metadata.enhanced}`);
  console.log(`   Enhancement Time: ${new Date(enhanced.metadata.enhancementTime).toISOString()}`);

  // 5. Use the enhanced module exactly like the original
  console.log('\\n🔧 Testing Enhanced Module:');
  console.log('-'.repeat(30));

  try {
    // Initialize
    await enhanced.enhanced.initialize();

    // Get status
    const status = enhanced.enhanced.getStatus();
    console.log('\\n📊 Module Status:', JSON.stringify(status, null, 2));

    // Process a request
    console.log('\\n📤 Processing Request:');
    const response = await enhanced.enhanced.processIncoming({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: 'Hello World' }]
    });

    console.log('\\n📥 Response Received:');
    console.log('   Content:', response.data.choices[0].message.content);
    console.log('   Processing Time:', response.metadata.processingTime, 'ms');

    // Check debug information
    console.log('\\n📈 Debug Information:');
    const stats = enhanced.logger.getStatistics();
    console.log(`   Total Logs: ${stats.totalLogs}`);
    console.log(`   Performance Tracking: ${enhanced.config.performanceTracking}`);
    console.log(`   Request Logging: ${enhanced.config.requestLogging}`);
    console.log(`   Error Tracking: ${enhanced.config.errorTracking}`);

    // Show recent logs
    console.log('\\n📋 Recent Debug Logs:');
    const recentLogs = enhanced.logger.getRecentLogs(5);
    recentLogs.forEach((log, index) => {
      const timestamp = new Date(log.timestamp).toISOString();
      console.log(`   ${index + 1}. [${log.level.toUpperCase()}] ${timestamp}`);
      console.log(`      Category: ${log.category}`);
      console.log(`      Message: ${log.message}`);
      if (log.data) {
        console.log(`      Data: ${JSON.stringify(log.data, null, 2)}`);
      }
      console.log();
    });

  } finally {
    // Cleanup
    await enhanced.enhanced.cleanup();
  }

  console.log('🎉 Quick Start Example Complete!');
  console.log('\\n💡 Key Takeaways:');
  console.log('   • No changes needed to original module');
  console.log('   • One line of code to add full debugging');
  console.log('   • Automatic performance tracking and error handling');
  console.log('   • Seamless integration with existing DebugCenter');
  console.log('   • Configurable logging levels and features');
}

/**
 * Example: Configuration-Driven Enhancement
 */
export async function configurationExample() {
  console.log('\\n⚙️ Configuration-Driven Enhancement Example');
  console.log('='.repeat(50));

  import { EnhancementConfigManager } from '../src/modules/enhancement/enhancement-config-manager.js';

  // Simple module to enhance
  class ConfigurableModule {
    readonly id = 'configurable-module';
    readonly type = 'generic';

    async initialize(): Promise<void> {
      console.log('Configurable module initializing...');
    }

    async processIncoming(request: any): Promise<any> {
      console.log('Configurable module processing...');
      return { ...request, processed: true };
    }

    getStatus() {
      return { id: this.id, type: this.type, initialized: true };
    }
  }

  // Create configuration manager
  const debugCenter = new MockDebugCenter();
  const configManager = new EnhancementConfigManager(debugCenter);

  // Create module
  const module = new ConfigurableModule();

  // Enhance using configuration manager (automatically loads config)
  const enhanced = await configManager.enhanceModule(
    module,
    'configurable-module',
    'generic'
  );

  console.log('\\n📋 Configuration-Driven Enhancement:');
  console.log(`   Module: ${enhanced.metadata.moduleId}`);
  console.log(`   Configuration loaded: ${configManager.isConfigLoaded()}`);
  console.log(`   Enhancement enabled: ${enhanced.config.enabled}`);
  console.log(`   Log level: ${enhanced.config.level}`);

  // Use the enhanced module
  try {
    await enhanced.enhanced.initialize();
    const result = await enhanced.enhanced.processIncoming({ test: true });
    console.log('\\n✅ Configuration-driven result:', result);
  } finally {
    await enhanced.enhanced.cleanup();
  }

  console.log('⚙️ Configuration Example Complete!');
}

/**
 * Example: Progressive Enhancement Pattern
 */
export async function progressiveEnhancementExample() {
  console.log('\\n🔄 Progressive Enhancement Pattern Example');
  console.log('='.repeat(50));

  class ProgressiveModule {
    private enhanced: any = null;
    private debugCenter: any;

    constructor(debugCenter: any) {
      this.debugCenter = debugCenter;
    }

    async initialize(): Promise<void> {
      console.log('Progressive module initializing...');

      // Try to create enhanced version
      try {
        const factory = new ModuleEnhancementFactory(this.debugCenter);
        this.enhanced = factory.createEnhancedModule(
          this,
          'progressive-module',
          'generic',
          {
            enabled: true,
            level: 'detailed',
            consoleLogging: true,
            debugCenter: true
          }
        );
        console.log('✅ Enhanced version created');
      } catch (error) {
        console.log('⚠️ Enhancement failed, using original module');
        // Enhancement failed, continue with original module
      }
    }

    async processIncoming(request: any): Promise<any> {
      // Use enhanced version if available, fallback to original
      if (this.enhanced) {
        return this.enhanced.enhanced.processIncoming(request);
      }

      // Original implementation
      console.log('Original module processing...');
      return { ...request, processed: true };
    }

    async cleanup(): Promise<void> {
      if (this.enhanced) {
        await this.enhanced.enhanced.cleanup();
      }
      console.log('Progressive module cleanup complete');
    }

    getStatus() {
      if (this.enhanced) {
        return {
          ...this.enhanced.enhanced.getStatus(),
          enhanced: true
        };
      }
      return { id: 'progressive-module', type: 'generic', enhanced: false };
    }
  }

  // Create and use progressive module
  const debugCenter = new MockDebugCenter();
  const module = new ProgressiveModule(debugCenter);

  console.log('\\n🔄 Testing Progressive Enhancement:');
  console.log('-'.repeat(30));

  try {
    await module.initialize();

    const status = module.getStatus();
    console.log('\\n📊 Status:', JSON.stringify(status, null, 2));

    const result = await module.processIncoming({ test: true });
    console.log('\\n✅ Result:', result);

  } finally {
    await module.cleanup();
  }

  console.log('🔄 Progressive Enhancement Example Complete!');
  console.log('\\n💡 Benefits of Progressive Enhancement:');
  console.log('   • Graceful fallback if enhancement fails');
  console.log('   • Zero risk to existing functionality');
  console.log('   • Can be deployed incrementally');
  console.log('   • Easy to enable/disable per environment');
}

// Run examples
export async function runQuickStartExamples() {
  try {
    await quickStartExample();
    await configurationExample();
    await progressiveEnhancementExample();

    console.log('\\n🎯 All Quick Start Examples Complete!');
    console.log('\\n📚 Next Steps:');
    console.log('   1. Check out the CLI tool: node scripts/enhance-module.js');
    console.log('   2. Review the templates in src/modules/enhancement/templates/');
    console.log('   3. Read the full documentation: docs/MODULE_ENHANCEMENT_SYSTEM.md');
    console.log('   4. Try enhancing your own modules!');

  } catch (error) {
    console.error('❌ Quick Start Example Failed:', error);
    console.error(error.stack);
  }
}

// Auto-run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  runQuickStartExamples();
}