import { describe, test, expect } from '@jest/globals';
import { AdvBaseModule } from '../sharedmodule/rcc-basemodule-adv/adv-base-module.js';

// Mock legacy BaseModule behavior
class LegacyBaseModule {
  constructor() {
    this.id = 'legacy-module';
    this.type = 'legacy';
  }

  getModuleId() {
    return this.id;
  }

  getModuleType() {
    return this.type;
  }

  async processIncoming(request) {
    // Legacy implementation without dry-run
    return {
      ...request,
      _metadata: { processed: true, timestamp: Date.now() }
    };
  }

  async processOutgoing(response) {
    return response;
  }
}

// Same module migrated to AdvBaseModule
class MigratedModule extends AdvBaseModule {
  constructor() {
    super();
    this.id = 'migrated-module';
    this.type = 'migrated';
  }

  getModuleId() {
    return this.id;
  }

  getModuleType() {
    return this.type;
  }

  async processIncoming(request) {
    return this.runWithDryRun(
      { opName: 'processIncoming', phase: 'request', direction: 'incoming' },
      request,
      async () => {
        // Original logic wrapped in dry-run
        return {
          ...request,
          _metadata: { processed: true, timestamp: Date.now() }
        };
      },
      { nodeId: this.id, nodeType: this.type }
    );
  }

  async processOutgoing(response) {
    return this.runWithDryRun(
      { opName: 'processOutgoing', phase: 'response', direction: 'outgoing' },
      response,
      async () => {
        return response;
      },
      { nodeId: this.id, nodeType: this.type }
    );
  }
}

describe('AdvBaseModule Migration Tests', () => {
  describe('Backward Compatibility', () => {
    test('legacy module should work without dry-run', async () => {
      const legacy = new LegacyBaseModule();
      const request = { data: 'test' };
      
      const result = await legacy.processIncoming(request);
      
      expect(result).toHaveProperty('_metadata.processed', true);
      expect(result).toHaveProperty('data', 'test');
    });

    test('migrated module should work with dry-run disabled', async () => {
      const migrated = new MigratedModule();
      migrated.setDryRunMode(false); // Ensure dry-run is disabled
      
      const request = { data: 'test' };
      const result = await migrated.processIncoming(request);
      
      // Should behave exactly like legacy module
      expect(result).toHaveProperty('_metadata.processed', true);
      expect(result).toHaveProperty('data', 'test');
    });

    test('migrated module should provide dry-run capability when enabled', async () => {
      const migrated = new MigratedModule();
      migrated.setDryRunMode(true);
      migrated.setNodeDryRunConfig('migrated-module', {
        enabled: true,
        mode: 'full-analysis',
        breakpointBehavior: 'no-propagation',
        verbosity: 'normal'
      });
      
      const request = { data: 'test' };
      const result = await migrated.processIncoming(request);
      
      // Should return dry-run result
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('inputData');
      expect(result).toHaveProperty('expectedOutput');
      expect(result.inputData).toEqual(request);
    });
  });

  describe('Migration Patterns', () => {
    test('should support gradual migration with mixed modes', async () => {
      // Simulate a pipeline with mixed legacy and migrated modules
      const legacyModule = new LegacyBaseModule();
      const migratedModule = new MigratedModule();
      
      // Migrated module in dry-run mode
      migratedModule.setDryRunMode(true);
      migratedModule.setNodeDryRunConfig('migrated-module', {
        enabled: true,
        mode: 'full-analysis',
        breakpointBehavior: 'continue',
        verbosity: 'normal'
      });
      
      const request = { data: 'test', step: 1 };
      
      // Legacy module processing
      const legacyResult = await legacyModule.processIncoming(request);
      
      // Migrated module processing (should continue to real execution)
      const migratedResult = await migratedModule.processIncoming(legacyResult);
      
      // Should work seamlessly together
      expect(legacyResult).toHaveProperty('_metadata.processed', true);
      expect(migratedResult).toHaveProperty('_metadata.processed', true);
      expect(migratedResult).toHaveProperty('step', 1);
    });

    test('should support feature flags for gradual rollout', async () => {
      class FeatureFlagModule extends AdvBaseModule {
        constructor(enableDryRun = false) {
          super();
          this.id = 'feature-flag-module';
          this.type = 'feature-flag';
          this.setDryRunMode(enableDryRun);
        }

        getModuleId() {
          return this.id;
        }

        getModuleType() {
          return this.type;
        }

        async processIncoming(request) {
          const enableDryRun = this.getDryRunConfig().enabled;
          
          if (!enableDryRun) {
            // Legacy behavior
            return {
              ...request,
              _metadata: { processed: true, mode: 'legacy' }
            };
          }
          
          // New behavior with dry-run
          return this.runWithDryRun(
            { opName: 'processIncoming', phase: 'request', direction: 'incoming' },
            request,
            async () => {
              return {
                ...request,
                _metadata: { processed: true, mode: 'dry-run-enabled' }
              };
            },
            { nodeId: this.id, nodeType: this.type }
          );
        }
      }
      
      // Test with feature flag disabled
      const legacyMode = new FeatureFlagModule(false);
      const legacyResult = await legacyMode.processIncoming({ data: 'test' });
      expect(legacyResult._metadata.mode).toBe('legacy');
      
      // Test with feature flag enabled
      const newMode = new FeatureFlagModule(true);
      newMode.setNodeDryRunConfig('feature-flag-module', {
        enabled: true,
        mode: 'full-analysis',
        breakpointBehavior: 'no-propagation',
        verbosity: 'normal'
      });
      
      const newResult = await newMode.processIncoming({ data: 'test' });
      expect(newResult).toHaveProperty('status');
      expect(newResult.inputData._metadata.mode).toBe('dry-run-enabled');
    });
  });

  describe('Configuration Migration', () => {
    test('should support runtime configuration changes', async () => {
      const module = new MigratedModule();
      const request = { data: 'test' };
      
      // Start with dry-run disabled
      module.setDryRunMode(false);
      const result1 = await module.processIncoming(request);
      expect(result1).toHaveProperty('_metadata.processed', true);
      expect(result1).not.toHaveProperty('status');
      
      // Enable dry-run at runtime
      module.setDryRunMode(true);
      module.setNodeDryRunConfig('migrated-module', {
        enabled: true,
        mode: 'full-analysis',
        breakpointBehavior: 'no-propagation',
        verbosity: 'normal'
      });
      
      const result2 = await module.processIncoming(request);
      expect(result2).toHaveProperty('status');
      expect(result2).toHaveProperty('inputData');
      
      // Disable dry-run again
      module.setDryRunMode(false);
      const result3 = await module.processIncoming(request);
      expect(result3).toHaveProperty('_metadata.processed', true);
      expect(result3).not.toHaveProperty('status');
    });

    test('should support per-node configuration', async () => {
      class MultiNodeModule extends AdvBaseModule {
        constructor() {
          super();
          this.id = 'multi-node-module';
          this.type = 'multi-node';
        }

        getModuleId() {
          return this.id;
        }

        getModuleType() {
          return this.type;
        }

        async processIncoming(request) {
          return this.runWithDryRun(
            { opName: 'processIncoming', phase: 'request', direction: 'incoming' },
            request,
            async () => {
              return { ...request, processed: true };
            },
            { nodeId: 'node-1', nodeType: 'processing' }
          );
        }

        async processOutgoing(response) {
          return this.runWithDryRun(
            { opName: 'processOutgoing', phase: 'response', direction: 'outgoing' },
            response,
            async () => {
              return response;
            },
            { nodeId: 'node-2', nodeType: 'output' }
          );
        }
      }
      
      const module = new MultiNodeModule();
      module.setDryRunMode(true);
      
      // Configure different behaviors for different nodes
      module.setNodeDryRunConfig('node-1', {
        enabled: true,
        mode: 'full-analysis',
        breakpointBehavior: 'no-propagation',
        verbosity: 'normal'
      });
      
      module.setNodeDryRunConfig('node-2', {
        enabled: true,
        mode: 'output-validation',
        breakpointBehavior: 'continue',
        verbosity: 'minimal'
      });
      
      const request = { data: 'test' };
      const incomingResult = await module.processIncoming(request);
      const outgoingResult = await module.processOutgoing({ data: 'output' });
      
      // Node-1 should return dry-run result
      expect(incomingResult).toHaveProperty('status');
      expect(incomingResult.nodeId).toBe('node-1');
      
      // Node-2 should continue to real execution
      expect(outgoingResult).toEqual({ data: 'output' });
    });
  });
});