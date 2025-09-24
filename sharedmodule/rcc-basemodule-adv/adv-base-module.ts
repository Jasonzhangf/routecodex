import { BaseModule } from '../../src/core/base-module.js';
import type {
  DryRunConfig,
  NodeDryRunConfig,
  DryRunContext,
  NodeDryRunResult,
  ValidationResult,
  OperationDescriptor,
  PerformanceMetrics
} from './types.js';

/**
 * AdvBaseModule
 *
 * Extends the project's BaseModule with native dry-run capabilities.
 * This class is designed as a migration target to replace BaseModule
 * as parent for all modules, progressively.
 */
export abstract class AdvBaseModule extends BaseModule {
  private advDryRunConfig: DryRunConfig = {
    enabled: false,
    mode: 'partial',
    verbosity: 'normal',
    includePerformanceEstimate: true,
    includeConfigValidation: false,
    sensitiveFields: ['apiKey', 'token', 'authorization', 'secret', 'password']
  };

  private nodeDryRunConfigs: Map<string, NodeDryRunConfig> = new Map();

  // ---- Public API ----
  setDryRunMode(enabled: boolean, config?: Partial<DryRunConfig>): void {
    this.advDryRunConfig.enabled = enabled;
    if (config) this.advDryRunConfig = { ...this.advDryRunConfig, ...config };
  }

  getDryRunConfig(): DryRunConfig {
    return { ...this.advDryRunConfig };
  }

  setNodeDryRunConfig(nodeId: string, config: NodeDryRunConfig): void {
    this.nodeDryRunConfigs.set(nodeId, config);
  }

  getNodeDryRunConfig(nodeId: string): NodeDryRunConfig | undefined {
    return this.nodeDryRunConfigs.get(nodeId);
  }

  /**
   * Wrap an operation with dry-run capability.
   * - If dry-run is disabled: executes real logic.
   * - If enabled: executes or simulates based on node/operation config,
   *   records logs and emits debug events.
   */
  async runWithDryRun<T>(
    op: OperationDescriptor,
    input: any,
    exec: () => Promise<T>,
    options?: { nodeId?: string; nodeType?: string; requestId?: string; pipelineId?: string }
  ): Promise<T | NodeDryRunResult> {
    const cfg = this.getDryRunConfig();
    if (!cfg.enabled) return exec();

    const nodeId = options?.nodeId || this.getModuleId();
    const nodeType = options?.nodeType || this.getModuleType();
    const requestId = options?.requestId || `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const ctx: DryRunContext = {
      requestId,
      pipelineId: options?.pipelineId,
      nodeId,
      nodeType,
      phase: op.phase,
      metadata: { opName: op.opName, direction: op.direction }
    };

    const nodeCfg = this.getNodeDryRunConfig(nodeId) || this.getDefaultNodeDryRunConfig();

    // Execute based on node mode
    let result: NodeDryRunResult;
    switch (nodeCfg.mode) {
      case 'output-validation':
        result = await this.executeDryRunValidation(input, ctx, nodeCfg);
        break;
      case 'full-analysis':
        result = await this.executeNodeDryRun(input, ctx);
        break;
      case 'error-simulation':
        result = await this.executeDryRunErrorSimulation(input, ctx, nodeCfg);
        break;
      default:
        result = await this.executeNodeDryRun(input, ctx);
        break;
    }

    await this.onDryRunResult(ctx, result);

    // Breakpoint behavior
    const b = nodeCfg.breakpointBehavior;
    if (b === 'pause') {
      await this.pauseForInspection(ctx, result);
      return result;
    }
    if (b === 'terminate') {
      await this.emitDryRunEvent('dryrun:terminated', ctx, { result });
      return result; // terminate the op chain here (caller can decide to stop)
    }
    if (b === 'no-propagation') {
      // Do not run actual exec; only return dry-run result
      return result;
    }

    // 'continue': execute real logic after dry-run
    return exec();
  }

  // ---- Overridable hooks (default safe implementations) ----
  protected async executeNodeDryRun(input: any, ctx: DryRunContext): Promise<NodeDryRunResult> {
    const expected = await this.generateExpectedOutput(input, ctx.nodeType);
    const perf = await this.estimatePerformance(input);
    return this.createNodeDryRunResult(ctx, input, expected, 'success', [], perf);
  }

  protected async validateOutput(output: any, rules: any[]): Promise<ValidationResult[]> {
    void rules; // default no-op validation
    return [];
  }

  protected async simulateError(config: any): Promise<any> {
    return { message: 'simulated-error', config };
  }

  protected async estimatePerformance(_input: any): Promise<PerformanceMetrics> {
    return { estimatedTime: 5, estimatedMemory: 128, complexity: 1 };
  }

  protected async generateExpectedOutput(input: any, _nodeType: string): Promise<any> {
    // Default: shallow clone
    try { return JSON.parse(JSON.stringify(input)); } catch { return input; }
  }

  // ---- Internal helpers ----
  private getDefaultNodeDryRunConfig(): NodeDryRunConfig {
    return {
      enabled: true,
      mode: 'output-validation',
      breakpointBehavior: 'continue',
      verbosity: 'normal'
    } as NodeDryRunConfig;
  }

  private async executeDryRunValidation(input: any, ctx: DryRunContext, nodeCfg: NodeDryRunConfig): Promise<NodeDryRunResult> {
    const expected = await this.generateExpectedOutput(input, ctx.nodeType);
    const validations = await this.validateOutput(expected, nodeCfg.validationRules || []);
    const perf = await this.estimatePerformance(input);

    const status = validations.some(v => v.severity === 'error') ? 'error'
      : validations.some(v => v.severity === 'warning') ? 'warning' : 'success';

    return this.createNodeDryRunResult(ctx, input, expected, status, validations, perf);
  }

  private async executeDryRunErrorSimulation(input: any, ctx: DryRunContext, nodeCfg: NodeDryRunConfig): Promise<NodeDryRunResult> {
    const e = nodeCfg.errorSimulation;
    let simulated: any = null;
    if (e?.enabled && Math.random() < (e.probability || 0)) {
      simulated = await this.simulateError(e);
    }
    const perf = await this.estimatePerformance(input);
    return {
      nodeId: ctx.nodeId,
      nodeType: ctx.nodeType,
      status: 'simulated-error',
      inputData: input,
      expectedOutput: null,
      validationResults: [],
      performanceMetrics: perf,
      executionLog: [{ timestamp: Date.now(), level: 'info', message: 'simulated-error', data: { config: e, simulated } }],
      error: simulated
    };
  }

  protected createNodeDryRunResult(
    ctx: DryRunContext,
    input: any,
    expected: any,
    status: NodeDryRunResult['status'],
    validations: ValidationResult[],
    perf: PerformanceMetrics
  ): NodeDryRunResult {
    return {
      nodeId: ctx.nodeId,
      nodeType: ctx.nodeType,
      status,
      inputData: input,
      expectedOutput: expected,
      validationResults: validations,
      performanceMetrics: perf,
      executionLog: [{ timestamp: Date.now(), level: 'info', message: 'dry-run-executed', data: { ...ctx.metadata } }]
    };
  }

  protected async onDryRunResult(ctx: DryRunContext, result: NodeDryRunResult): Promise<void> {
    // Publish debug event & record snapshot if debug/recording systems available in BaseModule
    try {
      // Generic debug hooks inherited from BaseModule (logInfo/logDebug) are used here
      this.logInfo?.('dry-run:result', { ctx, result: this.redactSensitive(result) });
    } catch {
      // ignore
    }
    await this.emitDryRunEvent('dryrun:result', ctx, { result: this.redactSensitive(result) });
  }

  protected async pauseForInspection(ctx: DryRunContext, result: NodeDryRunResult): Promise<void> {
    await this.emitDryRunEvent('dryrun:breakpoint', ctx, { result: this.redactSensitive(result) });
    // Simple async pause that can be replaced with an external controller later
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  protected async emitDryRunEvent(type: string, ctx: DryRunContext, data?: any): Promise<void> {
    try {
      // If BaseModule has a debug center, log via it; otherwise, fallback to console
      this.logDebug?.(type, { ctx, data });
    } catch {
      // no-op
    }
  }

  protected redactSensitive<T = any>(obj: T): T {
    const fields = new Set(this.advDryRunConfig.sensitiveFields || []);
    const replacer = (k: string, v: any) => {
      if (fields.has(k.toLowerCase())) return '[REDACTED]';
      return v;
    };
    try { return JSON.parse(JSON.stringify(obj, replacer)); } catch { return obj; }
  }
}

