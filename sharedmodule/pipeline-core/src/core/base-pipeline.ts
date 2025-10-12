import type {
  PipelineRequest,
  PipelineResponse,
  PipelineConfig,
  PipelineStatus,
  LLMSwitchModule,
  WorkflowModule,
  CompatibilityModule,
  ProviderModule,
  ModuleDependencies,
  ModuleFactory,
} from '../interfaces/pipeline-interfaces';

export class BasePipeline {
  readonly pipelineId: string;
  readonly config: PipelineConfig;

  private modules: {
    llmSwitch: LLMSwitchModule | null;
    workflow: WorkflowModule | null;
    compatibility: CompatibilityModule | null;
    provider: ProviderModule | null;
  } = { llmSwitch: null, workflow: null, compatibility: null, provider: null };

  private isInitialized = false;

  constructor(
    config: PipelineConfig,
    private _errorHandlingCenter: any,
    private _debugCenter: any,
    private moduleFactory: ModuleFactory
  ) {
    this.pipelineId = config.id;
    this.config = config;
  }

  async initialize(): Promise<void> {
    const deps: ModuleDependencies = {
      errorHandlingCenter: this._errorHandlingCenter,
      debugCenter: this._debugCenter,
      logger: {
        logModule: () => {}, logError: () => {}, logDebug: () => {}, logPipeline: () => {},
        logRequest: () => {}, logResponse: () => {}, logTransformation: () => {}, logProviderRequest: () => {},
        getRequestLogs: () => ({ general: [], transformations: [], provider: [] }),
        getPipelineLogs: () => ({ general: [], transformations: [], provider: [] }),
        getRecentLogs: () => [], getTransformationLogs: () => [], getProviderLogs: () => [],
        getStatistics: () => ({ totalLogs: 0, logsByLevel: {}, logsByCategory: {}, logsByPipeline: {}, transformationCount: 0, providerRequestCount: 0 }),
        clearLogs: () => {}, exportLogs: () => ({}), log: () => {}
      } as any
    };

    if (this.config.modules.llmSwitch && this.config.modules.llmSwitch.enabled !== false) {
      this.modules.llmSwitch = await this.moduleFactory(this.config.modules.llmSwitch, deps) as LLMSwitchModule;
      await this.modules.llmSwitch.initialize();
    }
    if (this.config.modules.workflow && this.config.modules.workflow.enabled !== false) {
      this.modules.workflow = await this.moduleFactory(this.config.modules.workflow, deps) as WorkflowModule;
      await this.modules.workflow.initialize();
    }
    if (this.config.modules.compatibility && this.config.modules.compatibility.enabled !== false) {
      this.modules.compatibility = await this.moduleFactory(this.config.modules.compatibility, deps) as CompatibilityModule;
      await this.modules.compatibility.initialize();
    }
    if (this.config.modules.provider && this.config.modules.provider.enabled !== false) {
      this.modules.provider = await this.moduleFactory(this.config.modules.provider, deps) as ProviderModule;
      await this.modules.provider.initialize();
    }

    this.isInitialized = true;
  }

  async processRequest(request: PipelineRequest): Promise<PipelineResponse> {
    if (!this.isInitialized) throw new Error(`Pipeline ${this.pipelineId} is not initialized`);
    let dto = request;
    if (!this.modules.llmSwitch || !this.modules.provider) throw new Error('Required modules not initialized');
    dto = await this.modules.llmSwitch.processIncoming(dto as any) as any;
    if (this.modules.workflow) dto = await (this.modules.workflow as any).processIncoming(dto as any) as any;
    if (this.modules.compatibility) dto = await this.modules.compatibility.processIncoming(dto as any) as any;
    const providerPayload = await (this.modules.provider as any).processIncoming(dto.data);
    // If provider returns an async iterator (streaming), passthrough without aggregating or
    // applying outgoing conversions here. The router will consume the iterator and handle
    // protocol conversion + SSE event synthesis.
    const isAsyncIterable =
      providerPayload &&
      typeof providerPayload === 'object' &&
      typeof (providerPayload as any)[Symbol.asyncIterator] === 'function';

    let responseDto: any = {
      data: providerPayload,
      metadata: {
        pipelineId: this.pipelineId,
        processingTime: 0,
        stages: [],
        requestId: request.route?.requestId || 'unknown',
        streaming: isAsyncIterable === true,
      },
    };
    // Mirror current request into debug.request so downstream converters can access tools/input_schema
    try {
      const dbgEnabled = (request as any)?.debug?.enabled === true;
      if (dbgEnabled) {
        responseDto.debug = responseDto.debug || {};
        responseDto.debug.request = request.data;
      }
    } catch { /* ignore */ }
    if (!isAsyncIterable) {
      if (this.modules.compatibility) responseDto = await (this.modules.compatibility as any).processOutgoing(responseDto);
      if (this.modules.workflow) responseDto = await (this.modules.workflow as any).processOutgoing(responseDto);
      responseDto = await this.modules.llmSwitch.processOutgoing(responseDto);
    }
    return responseDto;
  }

  getStatus(): PipelineStatus {
    return {
      id: this.pipelineId,
      state: this.isInitialized ? 'ready' : 'initializing',
      modules: {
        llmSwitch: { type: this.config.modules.llmSwitch?.type || 'unknown', state: this.modules.llmSwitch ? 'ready' : 'missing', lastActivity: Date.now() },
        workflow: { type: this.config.modules.workflow?.type || 'unknown', state: this.modules.workflow ? 'ready' : 'missing', lastActivity: Date.now() },
        compatibility: { type: this.config.modules.compatibility?.type || 'unknown', state: this.modules.compatibility ? 'ready' : 'missing', lastActivity: Date.now() },
        provider: { type: this.config.modules.provider?.type || 'unknown', state: this.modules.provider ? 'ready' : 'missing', lastActivity: Date.now() },
      },
      metrics: { totalRequests: 0, successfulRequests: 0, failedRequests: 0, averageResponseTime: 0 }
    } as any;
  }

  async cleanup(): Promise<void> {
    const list = [this.modules.provider, this.modules.compatibility, this.modules.workflow, this.modules.llmSwitch];
    for (const m of list) { try { await (m as any)?.cleanup?.(); } catch { /* ignore */ } }
    this.isInitialized = false;
  }
}
