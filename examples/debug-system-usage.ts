/**
 * RouteCodex Debug System Usage Examples
 *
 * This file demonstrates various ways to use the RouteCodex debugging system
 * including basic setup, HTTP server integration, and module debugging.
 */

import express from 'express';
import {
  setupDebugSystem,
  setupHttpServerDebug,
  setupModuleDebug,
  DebugSystemManager,
  HttpServerDebugIntegration,
  ModuleDebugAdapterImpl
} from '../src/debug/index.js';

/**
 * Example 1: Basic Debug System Setup
 */
async function example1_BasicSetup() {
  console.log('=== Example 1: Basic Debug System Setup ===');

  try {
    // Setup debug system with REST API and WebSocket
    const debugManager = await setupDebugSystem({
      enableRestApi: true,
      enableWebSocket: true,
      restPort: 8080,
      wsPort: 8081
    });

    console.log('✅ Debug system initialized successfully');
    console.log('📊 REST API available at: http://localhost:8080/debug');
    console.log('🔌 WebSocket server available at: ws://localhost:8081/debug');

    // Get system health
    const health = debugManager.getHealth();
    console.log('🏥 System health:', health.status, `(Score: ${health.score.toFixed(1)})`);

    return debugManager;

  } catch (error) {
    console.error('❌ Failed to setup debug system:', error);
    throw error;
  }
}

/**
 * Example 2: HTTP Server Debug Integration
 */
async function example2_HttpServerIntegration() {
  console.log('=== Example 2: HTTP Server Debug Integration ===');

  try {
    // Create Express server
    const app = express();
    app.use(express.json());

    // Setup HTTP server debugging
    const httpIntegration = await setupHttpServerDebug({
      host: 'localhost',
      port: 3000,
      protocol: 'http'
    });

    // Apply debug middleware
    app.use(httpIntegration.getRequestMiddleware());
    app.use(httpIntegration.getResponseMiddleware());

    // Add some test routes
    app.get('/', (req, res) => {
      res.json({ message: 'Hello World!', timestamp: Date.now() });
    });

    app.post('/api/test', (req, res) => {
      res.json({
        message: 'Test endpoint',
        received: req.body,
        timestamp: Date.now()
      });
    });

    app.get('/api/slow', async (req, res) => {
      // Simulate slow response
      await new Promise(resolve => setTimeout(resolve, 1000));
      res.json({ message: 'Slow response completed' });
    });

    app.get('/api/error', (req, res) => {
      res.status(500).json({ error: 'This is a test error' });
    });

    // Start server
    const server = app.listen(3000, () => {
      console.log('🚀 HTTP server running on http://localhost:3000');
      console.log('📊 Debug endpoints available:');
      console.log('   - GET  /debug/health');
      console.log('   - GET  /debug/status');
      console.log('   - GET  /debug/adapters');
      console.log('   - GET  /debug/metrics');
    });

    // Demonstrate debug data access
    setTimeout(async () => {
      try {
        const stats = await httpIntegration.getDebugStatistics();
        console.log('📈 Debug statistics:', {
          totalRequests: stats.statistics.totalEvents,
          activeRequests: stats.statistics.activeSessions,
          averageResponseTime: stats.statistics.performance.avgResponseTime
        });
      } catch (error) {
        console.warn('Failed to get debug statistics:', error);
      }
    }, 5000);

    return { server, httpIntegration };

  } catch (error) {
    console.error('❌ Failed to setup HTTP server integration:', error);
    throw error;
  }
}

/**
 * Example 3: Module Debugging
 */
class TestModule {
  private name: string;
  private debugAdapter?: ModuleDebugAdapterImpl;

  constructor(name: string) {
    this.name = name;
  }

  async initialize(debugAdapter: ModuleDebugAdapterImpl) {
    this.debugAdapter = debugAdapter;
    console.log(`📦 Module ${this.name} initialized with debugging`);
  }

  async processData(data: any): Promise<any> {
    const startTime = Date.now();

    try {
      // Simulate data processing
      await new Promise(resolve => setTimeout(resolve, Math.random() * 100));

      const result = {
        processed: true,
        input: data,
        output: { value: data.value * 2, timestamp: Date.now() },
        processingTime: Date.now() - startTime
      };

      // Log to debug adapter if available
      if (this.debugAdapter) {
        console.log(`🔍 Debug capture for ${this.name}: processed data in ${result.processingTime}ms`);
      }

      return result;

    } catch (error) {
      console.error(`❌ Module ${this.name} processing error:`, error);
      throw error;
    }
  }

  async complexOperation(params: any): Promise<any> {
    // Simulate complex operation with potential failure
    if (Math.random() < 0.1) {
      throw new Error('Random failure in complex operation');
    }

    return {
      success: true,
      params,
      result: Math.random() * 1000,
      timestamp: Date.now()
    };
  }
}

async function example3_ModuleDebugging() {
  console.log('=== Example 3: Module Debugging ===');

  try {
    // Setup debug system
    const debugManager = await setupDebugSystem();

    // Create module debug adapter
    const moduleAdapter = await setupModuleDebug({
      id: 'test-module',
      name: 'Test Module',
      version: '1.0.0',
      type: 'processor'
    }, debugManager);

    // Create and initialize test module
    const testModule = new TestModule('TestProcessor');
    await testModule.initialize(moduleAdapter);

    // Start debugging session
    await debugManager.startDebugging({
      id: 'module-test-session',
      type: 'module',
      moduleId: 'test-module',
      timestamp: Date.now()
    });

    // Test module operations
    console.log('🔄 Testing module operations...');

    for (let i = 0; i < 5; i++) {
      try {
        const result = await testModule.processData({
          value: i,
          label: `test-${i}`
        });
        console.log(`✅ Operation ${i + 1}: ${result.processingTime}ms`);
      } catch (error) {
        console.log(`❌ Operation ${i + 1} failed:`, error.message);
      }
    }

    // Test complex operations
    console.log('🔄 Testing complex operations...');
    for (let i = 0; i < 10; i++) {
      try {
        const result = await testModule.complexOperation({
          iteration: i,
          test: true
        });
        console.log(`✅ Complex operation ${i + 1}: success`);
      } catch (error) {
        console.log(`❌ Complex operation ${i + 1} failed:`, error.message);
      }
    }

    // Get debug data
    const debugData = await debugManager.getDebugData({
      id: 'module-test-session',
      type: 'module',
      moduleId: 'test-module',
      timestamp: Date.now()
    });

    console.log('📊 Debug data collected:', debugData.length, 'items');

    // Get module statistics
    const stats = moduleAdapter.getStats();
    console.log('📈 Module statistics:', {
      totalSessions: stats.totalSessions,
      totalEvents: stats.totalEvents,
      totalErrors: stats.totalErrors,
      averageResponseTime: stats.performance.avgResponseTime.toFixed(2) + 'ms'
    });

    return { debugManager, moduleAdapter, testModule };

  } catch (error) {
    console.error('❌ Failed to setup module debugging:', error);
    throw error;
  }
}

/**
 * Example 4: Advanced Configuration
 */
async function example4_AdvancedConfiguration() {
  console.log('=== Example 4: Advanced Configuration ===');

  try {
    // Setup debug system with custom configuration
    const debugManager = DebugSystemManager.getInstance({
      enabled: true,
      logLevel: 'verbose',
      maxEntries: 5000,
      enableConsole: true,
      enableFileLogging: false,
      enableWebSocket: true,
      wsPort: 8082,
      enableRestApi: true,
      restPort: 8083,
      enablePerformanceMonitoring: true,
      enableMemoryProfiling: true,
      enableRequestCapture: true,
      enableErrorTracking: true,
      adapters: [
        {
          id: 'custom-adapter-1',
          type: 'module',
          className: 'ModuleDebugAdapterImpl',
          enabled: true,
          config: {
            moduleInfo: {
              id: 'custom-module-1',
              name: 'Custom Module 1',
              version: '2.0.0',
              type: 'processor'
            }
          }
        },
        {
          id: 'custom-adapter-2',
          type: 'server',
          className: 'HttpServerDebugAdapterImpl',
          enabled: true,
          config: {
            serverInfo: {
              host: 'localhost',
              port: 3001,
              protocol: 'http'
            }
          }
        }
      ]
    });

    await debugManager.initialize();

    console.log('✅ Advanced debug system initialized');
    console.log('📊 REST API: http://localhost:8083/debug');
    console.log('🔌 WebSocket: ws://localhost:8082/debug');

    // Get configuration
    const config = debugManager.getConfiguration();
    console.log('⚙️  Configuration:', {
      adapters: config.adapters.length,
      websocketEnabled: config.global.enableWebSocket,
      restApiEnabled: config.global.enableRestApi,
      performanceMonitoring: config.global.enablePerformanceMonitoring
    });

    // Update configuration dynamically
    await debugManager.updateConfiguration({
      global: {
        logLevel: 'detailed',
        maxEntries: 10000
      }
    });

    console.log('📝 Configuration updated dynamically');

    return debugManager;

  } catch (error) {
    console.error('❌ Failed to setup advanced configuration:', error);
    throw error;
  }
}

/**
 * Example 5: Error Handling and Recovery
 */
async function example5_ErrorHandling() {
  console.log('=== Example 5: Error Handling and Recovery ===');

  try {
    const debugManager = await setupDebugSystem();

    // Simulate various error scenarios
    console.log('🧪 Testing error handling...');

    // Test 1: Invalid adapter configuration
    try {
      await debugManager.createModuleAdapter(
        'invalid-module',
        {
          id: 'invalid-module',
          name: 'Invalid Module',
          version: '1.0.0',
          type: 'invalid'
        }
      );
      console.log('❌ Should have failed for invalid module type');
    } catch (error) {
      console.log('✅ Correctly handled invalid module type:', error.message);
    }

    // Test 2: Invalid debug context
    try {
      await debugManager.startDebugging({
        id: '', // Invalid empty ID
        type: 'test' as any // Invalid type
      });
      console.log('❌ Should have failed for invalid context');
    } catch (error) {
      console.log('✅ Correctly handled invalid context:', error.message);
    }

    // Test 3: Get debug data for non-existent session
    try {
      const data = await debugManager.getDebugData({
        id: 'non-existent-session',
        type: 'session',
        timestamp: Date.now()
      });
      console.log('📊 Non-existent session data:', data.length, 'items (empty is expected)');
    } catch (error) {
      console.log('⚠️  Handled non-existent session gracefully');
    }

    // Check system health after errors
    const health = debugManager.getHealth();
    console.log('🏥 System health after error tests:', health.status);

    return debugManager;

  } catch (error) {
    console.error('❌ Error handling test failed:', error);
    throw error;
  }
}

/**
 * Main runner function
 */
async function runExamples() {
  console.log('🚀 RouteCodex Debug System Examples');
  console.log('=====================================');

  let examples: any[] = [];

  try {
    // Run examples
    examples.push(await example1_BasicSetup());
    console.log();

    examples.push(await example2_HttpServerIntegration());
    console.log();

    examples.push(await example3_ModuleDebugging());
    console.log();

    examples.push(await example4_AdvancedConfiguration());
    console.log();

    examples.push(await example5_ErrorHandling());
    console.log();

    console.log('🎉 All examples completed successfully!');
    console.log('');
    console.log('📚 Summary of running examples:');
    console.log('   1. Basic debug system setup with REST API and WebSocket');
    console.log('   2. HTTP server integration with request/response capture');
    console.log('   3. Module debugging with method hooks and state capture');
    console.log('   4. Advanced configuration with multiple adapters');
    console.log('   5. Error handling and recovery scenarios');

    // Keep examples running for a while to allow testing
    console.log('');
    console.log('⏱️  Keeping examples running for 30 seconds...');
    await new Promise(resolve => setTimeout(resolve, 30000));

  } catch (error) {
    console.error('❌ Example execution failed:', error);
  } finally {
    // Cleanup
    console.log('🧹 Cleaning up examples...');
    for (const example of examples) {
      try {
        if (example.debugManager) {
          await example.debugManager.destroy();
        }
        if (example.server) {
          example.server.close();
        }
        if (example.httpIntegration) {
          await example.httpIntegration.destroy();
        }
      } catch (cleanupError) {
        console.warn('Cleanup warning:', cleanupError);
      }
    }
    console.log('✅ Cleanup completed');
  }
}

// Run examples if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runExamples().catch(console.error);
}

export {
  example1_BasicSetup,
  example2_HttpServerIntegration,
  example3_ModuleDebugging,
  example4_AdvancedConfiguration,
  example5_ErrorHandling,
  runExamples
};