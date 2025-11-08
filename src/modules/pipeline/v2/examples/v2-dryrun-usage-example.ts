/**
 * V2 Dry Run Usage Examples
 *
 * Demonstrates how to use V2 parallel dry run functionality in various scenarios.
 */
import { API_ENDPOINTS } from "../../../constants/index.js";
import type { V2SystemConfig, PipelineRequest, PipelineResponse } from '../types/v2-types.js';
import { V2DryRunFactory } from '../integration/v2-dryrun-factory.js';

/**
 * Example 1: Basic V2 Dry Run Setup
 */
export async function basicSetupExample(): Promise<void> {
  console.log('=== Basic V2 Dry Run Setup ===');

  // Define V2 configuration
  const v2Config: V2SystemConfig = {
    version: '2.0',
    system: {
      mode: 'v2',
      enableDryRun: false,
      featureFlags: {
        enableV2Routing: true,
        enableValidation: true
      }
    },
    staticInstances: {
      preloadModules: ['provider-default', 'compatibility-default', 'llmswitch-default'],
      poolConfig: {
        maxInstancesPerType: 3,
        warmupInstances: 1,
        idleTimeout: 300000
      }
    },
    virtualPipelines: {
      routeTable: {
        routes: [
          {
            id: 'default',
            pattern: {},
            modules: [
              { type: 'provider-default' },
              { type: 'compatibility-default' },
              { type: 'llmswitch-default' }
            ],
            priority: 0
          }
        ],
        defaultRoute: 'default'
      },
      moduleRegistry: {
        providers: {
          'provider-default': {
            type: 'provider',
            config: {
              providerType: 'openai',
              baseUrl: API_ENDPOINTS.OPENAI,
              auth: {
                type: 'apikey',
                apiKey: 'test-key'
              }
            }
          }
        },
        compatibility: {
          'compatibility-default': {
            type: 'compatibility',
            config: {
              providerType: 'openai',
              fieldMappings: {
                request: { 'model': 'model', 'messages': 'messages' },
                response: { 'choices': 'choices' }
              }
            }
          }
        },
        llmSwitch: {
          'llmswitch-default': {
            type: 'llmswitch',
            config: {
              conversionType: 'anthropic-to-openai',
              protocol: 'openai'
            }
          }
        }
      }
    }
  };

  try {
    // Create V2 dry run manager
    const manager = await V2DryRunFactory.createManager(
      V2DryRunFactory.createDevelopmentConfig(v2Config),
      'example-basic'
    );

    // Start the manager
    await manager.start();

    console.log('✅ V2 dry run manager started successfully');

    // Simulate some requests
    for (let i = 0; i < 10; i++) {
      const request: PipelineRequest = {
        id: `test-${i}`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: {
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: `Test message ${i}` }]
        },
        metadata: { timestamp: Date.now() }
      };

      const v1Response: PipelineResponse = {
        id: `response-test-${i}`,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          choices: [{ message: { content: `V1 response ${i}` } }]
        },
        metadata: { timestamp: Date.now() }
      };

      // Process through V2 dry run
      manager.processRequest(`test-${i}`, request, v1Response, null, 150);
    }

    // Wait a bit for processing
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check metrics
    const metrics = manager.getMetrics();
    console.log('📊 Metrics:', {
      totalRequests: metrics.adapter.totalRequests,
      sampledRequests: metrics.adapter.sampledRequests,
      v1SuccessRate: metrics.parallel?.v1SuccessRate,
      v2SuccessRate: metrics.parallel?.v2SuccessRate,
      averageComparison: metrics.parallel?.averageComparison
    });

    // Get recent runs
    const recentRuns = V2DryRunFactory.getManager('example-basic')?.getRecentRuns(5) || [];
    console.log('📈 Recent runs:', recentRuns.map(run => ({
      requestId: run.requestId,
      v1Success: run.v1Success,
      v2Success: run.v2Success,
      similarity: run.comparison.similarity
    })));

    // Cleanup
    await manager.shutdown();
    console.log('🧹 Manager shutdown complete');

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

/**
 * Example 2: Integration with Express.js
 */
export function expressIntegrationExample(): void {
  console.log('=== Express.js Integration Example ===');

  // This shows how to integrate with Express.js middleware
  const exampleCode = `
import express from 'express';
import { V2DryRunFactory } from './src/modules/pipeline/v2/integration/v2-dryrun-factory.js';

async function setupExpressApp() {
  const app = express();
  app.use(express.json());

  // Create V2 dry run manager
  const v2Config = { /* your V2 config */ };
  const dryRunManager = await V2DryRunFactory.createManager(
    V2DryRunFactory.createProductionConfig(v2Config),
    'express-app'
  );

  // Add V2 dry run middleware
  app.use(V2PipelineIntegrationHelper.createExpressMiddleware(dryRunManager));

  // Your existing routes
  app.post('/api/chat', async (req, res) => {
    // Your existing V1 logic here
    const response = await processWithV1(req.body);
    res.json(response);
  });

  // Start server
  app.listen(3000, () => {
    console.log('Server running on port 3000 with V2 dry run enabled');
  });
}

setupExpressApp();
  `;

  console.log('Express integration code:');
  console.log(exampleCode);
}

/**
 * Example 3: Custom Request Handler Wrapper
 */
export function customHandlerExample(): void {
  console.log('=== Custom Handler Wrapper Example ===');

  // Define a sample request handler
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function _sampleChatHandler(request: { messages: Record<string, unknown>[], model: string }): Promise<{
    choices: Array<{
      message: { content: string };
    }>;
  }> {
    // Simulate V1 processing
    await new Promise(resolve => setTimeout(resolve, 100));

    return {
      choices: [{
        message: {
          content: `V1 response for ${request.model}`
        }
      }]
    };
  }

  // This shows how to wrap existing handlers
  const exampleCode = `
import { V2DryRunFactory, V2PipelineIntegrationHelper } from './src/modules/pipeline/v2/integration/v2-dryrun-factory.js';

async function setupWrappedHandler() {
  // Create V2 dry run manager
  const v2Config = { /* your V2 config */ };
  const dryRunManager = await V2DryRunFactory.createManager(
    V2DryRunFactory.createDevelopmentConfig(v2Config),
    'wrapped-handler'
  );
  await dryRunManager.start();

  // Wrap your existing handler
  const wrappedHandler = V2PipelineIntegrationHelper.wrapRequestHandler(
    dryRunManager,
    sampleChatHandler
  );

  // Use the wrapped handler exactly like the original
  const request = {
    messages: [{ role: 'user', content: 'Hello' }],
    model: 'gpt-3.5-turbo'
  };

  const response = await wrappedHandler(request);
  console.log('Response:', response);

  // V2 dry run happens automatically in parallel!
}

setupWrappedHandler();
  `;

  console.log('Custom handler wrapper code:');
  console.log(exampleCode);
}

/**
 * Example 4: Monitoring and Health Checks
 */
export async function monitoringExample(): Promise<void> {
  console.log('=== Monitoring and Health Checks ===');

  const v2Config: V2SystemConfig = {
    // ... (same config as basic example)
    version: '2.0',
    system: { mode: 'v2', enableDryRun: false, featureFlags: {} },
    staticInstances: { preloadModules: [], poolConfig: { maxInstancesPerType: 1, warmupInstances: 1, idleTimeout: 300000 } },
    virtualPipelines: {
      routeTable: { routes: [], defaultRoute: 'default' },
      moduleRegistry: { providers: {}, compatibility: {}, llmSwitch: {} }
    }
  };

  try {
    // Create manager with monitoring enabled
    const manager = await V2DryRunFactory.createManager(
      {
        v2Config,
        enabled: true,
        sampleRate: 0.2, // 20% sampling for monitoring
        autoStart: true,
        failureThreshold: 0.4, // 40% failure threshold
        loggingLevel: 'detailed'
      },
      'monitoring-example'
    );

    console.log('✅ Manager created with monitoring enabled');

    // Simulate periodic monitoring
    const monitoringInterval = setInterval(() => {
      const status = manager.getStatus();
      const metrics = manager.getMetrics();

      console.log('📊 Status Update:', {
        healthStatus: status.healthStatus,
        totalRequests: status.totalRequests,
        sampledRequests: status.sampledRequests,
        failureRate: status.currentFailureRate,
        v1SuccessRate: metrics.parallel?.v1SuccessRate,
        v2SuccessRate: metrics.parallel?.v2SuccessRate
      });

      // Example: Auto-adjust sampling rate based on performance
      if (metrics.parallel && metrics.parallel.averageComparison > 0.9) {
        console.log('🎯 High similarity detected - could increase sampling rate');
      }

      if (metrics.parallel && metrics.parallel.v2SuccessRate < 0.8) {
        console.log('⚠️ Low V2 success rate detected');
      }

    }, 5000); // Every 5 seconds

    // Simulate some load
    for (let i = 0; i < 50; i++) {
      const request: PipelineRequest = {
        id: `monitor-test-${i}`,
        method: 'POST',
        headers: {},
        body: { model: 'test', messages: [{ role: 'user', content: `Load test ${i}` }] },
        metadata: { timestamp: Date.now() }
      };

      const response: PipelineResponse = {
        id: `response-monitor-${i}`,
        status: 200,
        headers: {},
        body: { choices: [{ message: { content: `Response ${i}` } }] },
        metadata: { timestamp: Date.now() }
      };

      manager.processRequest(`monitor-test-${i}`, request, response, null, Math.random() * 200);

      // Random delay
      await new Promise(resolve => setTimeout(resolve, Math.random() * 100));
    }

    // Let monitoring run for a bit
    await new Promise(resolve => setTimeout(resolve, 10000));

    clearInterval(monitoringInterval);

    // Final metrics
    const finalMetrics = manager.getMetrics();
    console.log('📈 Final Metrics:', {
      totalRequests: finalMetrics.adapter.totalRequests,
      sampledRequests: finalMetrics.adapter.sampledRequests,
      performance: finalMetrics.performance
    });

    await manager.shutdown();
    console.log('🧹 Monitoring example complete');

  } catch (error) {
    console.error('❌ Monitoring error:', error);
  }
}

/**
 * Example 5: Configuration Management
 */
export function configurationExample(): void {
  console.log('=== Configuration Management Example ===');

  console.log('📋 Available configuration presets:');
  console.log('1. Development: High sampling, detailed logging, auto-start');
  console.log('2. Production: Low sampling, basic logging, manual start');
  console.log('3. Quick Start: Conservative sampling, basic setup');

  const configExamples = `
// Development Configuration
const devConfig = V2DryRunFactory.createDevelopmentConfig(v2Config);
// - 50% sampling rate
// - Auto-start enabled
// - Detailed logging
// - High failure threshold (90%)

// Production Configuration
const prodConfig = V2DryRunFactory.createProductionConfig(v2Config);
// - 2% sampling rate
// - Manual start
// - Basic logging
// - Lower failure threshold (30%)

// Quick Start Configuration
const quickConfig = V2DryRunFactory.createQuickStartConfig(v2Config);
// - 5% sampling rate
// - Auto-start enabled
// - Basic logging
// - High failure threshold (80%)

// Custom Configuration
const customConfig = {
  v2Config: yourV2Config,
  enabled: true,
  sampleRate: 0.15, // 15% sampling
  autoStart: false,
  failureThreshold: 0.6, // 60% failure threshold
  loggingLevel: 'basic'
};
  `;

  console.log(configExamples);

  console.log('💡 Best Practices:');
  console.log('- Start with Quick Start config for testing');
  console.log('- Use Development config during feature development');
  console.log('- Switch to Production config for production deployment');
  console.log('- Monitor health metrics and adjust thresholds accordingly');
  console.log('- Use factory instance management for multiple environments');
}

/**
 * Run all examples
 */
export async function runAllExamples(): Promise<void> {
  console.log('🚀 Running V2 Dry Run Usage Examples\n');

  try {
    await basicSetupExample();
    console.log('\n');

    expressIntegrationExample();
    console.log('\n');

    customHandlerExample();
    console.log('\n');

    await monitoringExample();
    console.log('\n');

    configurationExample();
    console.log('\n');

    console.log('✅ All examples completed successfully!');

  } catch (error) {
    console.error('❌ Example execution failed:', error);
  } finally {
    // Cleanup any remaining instances
    await V2DryRunFactory.shutdownAll();
  }
}

// Export for individual testing
export {
  basicSetupExample,
  expressIntegrationExample,
  customHandlerExample,
  monitoringExample,
  configurationExample
};