import type { LLMSwitchModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../../types/shared-dtos.js';
import { SwitchOrchestrator } from '@routecodex/llmswitch-core/conversion/switch-orchestrator';
import type { ConversionContext } from './conversion/types.js';
import path from 'path';
import { fileURLToPath } from 'url';

export interface ConversionRouterConfig {
  profilesPath?: string;
  defaultProfile?: string;
}

export class ConversionRouterLLMSwitch implements LLMSwitchModule {
  readonly id: string;
  readonly type = 'llmswitch-conversion-router';
  readonly protocol = 'switchboard';
  readonly config: ModuleConfig;

  private readonly orchestrator: SwitchOrchestrator;
  private initialized = false;

  constructor(config: ModuleConfig, dependencies: ModuleDependencies) {
    this.id = `llmswitch-conversion-router-${Date.now()}`;
    this.config = config;
    const routerConfig = (config.config as ConversionRouterConfig) || {};

    // Deterministically supply baseDir (routecodex package root) and a relative profilesPath.
    // No fallback: orchestrator will resolve relative to baseDir only, and throw if missing.
    const here = path.dirname(fileURLToPath(import.meta.url));
    // climb up to 'dist' directory
    let cursor = here;
    let distRoot: string | null = null;
    for (let i = 0; i < 8; i++) { // bounded climb
      if (path.basename(cursor) === 'dist') { distRoot = cursor; break; }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    const packageRoot = distRoot ? path.dirname(distRoot) : path.resolve(here, '../../../../../..');
    routerConfig.profilesPath = routerConfig.profilesPath || 'config/conversion/llmswitch-profiles.json';
    (routerConfig as any).baseDir = packageRoot;
    this.orchestrator = new SwitchOrchestrator(dependencies, routerConfig as any);

    // Register in-repo codecs to the core orchestrator (thin integration layer)
    const deps = dependencies;
    this.orchestrator.registerFactories({
      'openai-openai': async () => {
        const { OpenAIOpenAIConversionCodec } = await import('./conversion/codecs/openai-openai-codec.js');
        return new OpenAIOpenAIConversionCodec(deps);
      },
      'anthropic-openai': async () => {
        const { AnthropicOpenAIConversionCodec } = await import('./conversion/codecs/anthropic-openai-codec.js');
        return new AnthropicOpenAIConversionCodec(deps);
      },
      'responses-openai': async () => {
        const { ResponsesOpenAIConversionCodec } = await import('./conversion/codecs/responses-openai-codec.js');
        return new ResponsesOpenAIConversionCodec(deps);
      }
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.orchestrator.initialize();
    this.initialized = true;
  }

  async processIncoming(request: SharedPipelineRequest): Promise<SharedPipelineRequest> {
    await this.ensureInitialized();
    const ctx = this.buildContextFromRequest(request);
    const result = await this.orchestrator.prepareIncoming(request.data, ctx);
    return {
      ...request,
      data: result.payload,
      metadata: {
        ...(request.metadata || {}),
        conversionProfileId: result.profile.id
      }
    };
  }

  async processOutgoing(response: SharedPipelineResponse | any): Promise<SharedPipelineResponse | any> {
    await this.ensureInitialized();
    const isDto = response && typeof response === 'object' && 'data' in response && 'metadata' in response;
    const ctx = this.buildContextFromResponse(response);
    const payload = isDto ? (response as SharedPipelineResponse).data : response;
    const result = await this.orchestrator.prepareOutgoing(payload, ctx);

    if (isDto) {
      const existing = (response as SharedPipelineResponse).metadata || { pipelineId: 'conversion-router', processingTime: 0, stages: [] };
      const merged = { ...existing, conversionProfileId: result.profile.id } as any;
      return {
        ...(response as SharedPipelineResponse),
        data: result.payload,
        metadata: merged
      } as SharedPipelineResponse;
    }

    return result.payload;
  }

  async transformRequest(payload: unknown): Promise<unknown> {
    const dummyRequest: SharedPipelineRequest = {
      data: payload,
      route: {
        providerId: 'unknown',
        modelId: 'unknown',
        requestId: `req_${Date.now()}`,
        timestamp: Date.now()
      },
      metadata: {},
      debug: { enabled: false, stages: {} }
    };
    const transformed = await this.processIncoming(dummyRequest);
    return transformed.data;
  }

  async transformResponse(payload: unknown): Promise<unknown> {
    const dummyResponse: SharedPipelineResponse = {
      data: payload,
      metadata: {
        requestId: `req_${Date.now()}`,
        pipelineId: 'conversion-router',
        processingTime: 0,
        stages: []
      }
    } as SharedPipelineResponse;
    const transformed = await this.processOutgoing(dummyResponse) as SharedPipelineResponse;
    return transformed.data;
  }

  async cleanup(): Promise<void> {
    this.initialized = false;
  }

  private buildContextFromRequest(request: SharedPipelineRequest): ConversionContext {
    return {
      requestId: request.route?.requestId,
      endpoint: (request.metadata as any)?.endpoint,
      entryEndpoint: (request.metadata as any)?.entryEndpoint,
      targetProtocol: (request.metadata as any)?.targetProtocol,
      stream: Boolean((request.data as any)?.stream),
      metadata: request.metadata as Record<string, unknown> | undefined
    };
  }

  private buildContextFromResponse(response: SharedPipelineResponse | any): ConversionContext {
    if (response && typeof response === 'object' && 'metadata' in response) {
      const metadata = (response as SharedPipelineResponse).metadata as Record<string, unknown> | undefined;
      return {
        requestId: metadata?.requestId as string | undefined,
        endpoint: metadata?.endpoint as string | undefined,
        entryEndpoint: metadata?.entryEndpoint as string | undefined,
        targetProtocol: metadata?.targetProtocol as string | undefined,
        metadata
      };
    }
    return {};
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}
