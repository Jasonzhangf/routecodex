/**
 * Hybrid Pipeline Assembler
 * 
 * Assembles hybrid pipeline manager that can seamlessly route between V1 and V2
 * while maintaining compatibility with existing infrastructure.
 */

import type { MergedConfig } from '../../../../config/merged-config-types.js';
import type { PipelineManager } from '../../core/pipeline-manager.js';
import type { V2PipelineManager } from '../v2-pipeline-manager.js';
import type { HybridPipelineConfig, HybridPipelineManager } from './hybrid-pipeline-manager.js';
import { PipelineAssembler } from '../../config/pipeline-assembler.js';
import { V2PipelineAssembler } from '../v2-pipeline-assembler.js';
import { V2ConfigLibrary } from '../../config/v2-config-library.js';
import { PipelineDebugLogger } from '../../../utils/debug-logger.js';

/**
 * Assembled Hybrid Pipelines
 */
export interface AssembledHybridPipelines {
  manager: HybridPipelineManager;
  routePools: Record<string, string[]>;
  routeMeta: Record<string, { providerId: string; modelId: string; keyId: string }>;
  mode: 'v1' | 'v2' | 'hybrid';
}

/**
 * Hybrid Pipeline Assembler
 * 
 * Creates hybrid pipeline manager that can operate in V1, V2, or hybrid mode.
 * Maintains full compatibility with existing PipelineAssembler interface.
 */
export class HybridPipelineAssembler {
  private static readonly logger = new PipelineDebugLogger();

  /**
   * Assemble hybrid pipeline from configuration
   */
  static async assemble(mergedConfig: unknown): Promise<AssembledHybridPipelines> {
    this.logger.logModule('hybrid-assembler', 'assembly-start');

    try {
      // Extract hybrid configuration from merged config
      const hybridConfig = this.extractHybridConfig(mergedConfig);
      
      // Assemble V1 pipeline (always needed for fallback)
      const v1Assembly = await PipelineAssembler.assemble(mergedConfig);
      
      // Assemble V2 pipeline if needed
      let v2Manager: V2PipelineManager | undefined;
      if (hybridConfig.mode === 'v2' || hybridConfig.mode === 'hybrid') {
        v2Manager = await this.assembleV2Pipeline(hybridConfig.v2Config);
      }
      
      // Create hybrid manager
      const hybridManager = new HybridPipelineManager(
        hybridConfig,
        this.logger
      );
      
      // Initialize with both managers
      await hybridManager.initialize(v1Assembly.manager, v2Manager);
      
      const result: AssembledHybridPipelines = {
        manager: hybridManager,
        routePools: v1Assembly.routePools,
        routeMeta: v1Assembly.routeMeta,
        mode: hybridConfig.mode
      };
      
      this.logger.logModule('hybrid-assembler', 'assembly-complete', {
        mode: hybridConfig.mode,
        hasV2Manager: !!v2Manager,
        routePoolsCount: Object.keys(v1Assembly.routePools).length
      });
      
      return result;
      
    } catch (error) {
      this.logger.logModule('hybrid-assembler', 'assembly-error', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Extract hybrid configuration from merged config
   */
  private static extractHybridConfig(mergedConfig: unknown): HybridPipelineConfig {
    const config = mergedConfig as Record<string, any>;
    const systemConfig = config.system || {};
    
    // Default to V1 mode for backward compatibility
    const mode = systemConfig.pipelineMode || 'v1';
    
    // Extract V2 configuration if present
    let v2Config;
    if (config.v2Config) {
      v2Config = config.v2Config;
    } else if (mode !== 'v1') {
      // Try to generate V2 config from V1 config
      v2Config = V2ConfigLibrary.getInstance().generateFromV1(config);
    }
    
    // Extract traffic split configuration
    const trafficSplit = systemConfig.trafficSplit;
    
    // Default migration settings
    const migration = {
      enableProgressive: systemConfig.enableProgressiveMigration === true,
      schedule: {
        startPercentage: systemConfig.migrationStartPercentage || 10,
        targetPercentage: systemConfig.migrationTargetPercentage || 100,
        durationHours: systemConfig.migrationDurationHours || 24,
        updateIntervalMinutes: systemConfig.migrationUpdateIntervalMinutes || 30
      }
    };
    
    // Default health check settings
    const healthCheck = {
      enabled: systemConfig.enableHealthBasedRouting !== false,
      errorRateThreshold: systemConfig.errorRateThreshold || 0.1,
      latencyThresholdMs: systemConfig.latencyThresholdMs || 10000,
      minSamples: systemConfig.healthCheckMinSamples || 100
    };
    
    // Default fallback settings
    const fallback = {
      enabled: systemConfig.enableFallback !== false,
      errorTypes: systemConfig.fallbackErrorTypes || ['timeout', 'connection', 'upstream'],
      cooldownMs: systemConfig.fallbackCooldownMs || 60000
    };
    
    return {
      mode: mode as 'v1' | 'v2' | 'hybrid',
      v2Config,
      trafficSplit,
      migration,
      healthCheck,
      fallback
    };
  }

  /**
   * Assemble V2 pipeline manager
   */
  private static async assembleV2Pipeline(v2Config?: any): Promise<V2PipelineManager | undefined> {
    if (!v2Config) {
      return undefined;
    }
    
    try {
      const v2Manager = new V2PipelineManager();
      await v2Manager.initialize(v2Config);
      
      this.logger.logModule('hybrid-assembler', 'v2-assembled', {
        hasConfig: !!v2Config,
        routes: v2Config.virtualPipelines?.routeTable?.routes?.length || 0
      });
      
      return v2Manager;
      
    } catch (error) {
      this.logger.logModule('hybrid-assembler', 'v2-assembly-failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      
      // Don't fail the entire hybrid assembly if V2 fails
      return undefined;
    }
  }

  /**
   * Assemble from file (compatibility with existing interface)
   */
  static async assembleFromFile(mergedConfigPath: string): Promise<AssembledHybridPipelines> {
    const fs = await import('fs/promises');
    const path = await import('path');
    
    const abs = mergedConfigPath.startsWith('.') 
      ? path.resolve(process.cwd(), mergedConfigPath) 
      : mergedConfigPath;
    
    const content = await fs.readFile(abs, 'utf-8');
    const mergedConfig = JSON.parse(content);
    
    return this.assemble(mergedConfig);
  }
}
