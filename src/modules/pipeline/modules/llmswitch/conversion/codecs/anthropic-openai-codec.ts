import type { ModuleDependencies } from '../../../../interfaces/pipeline-interfaces.js';
import type { ConversionCodec, ConversionContext, ConversionProfile } from '../types.js';
import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../../../../types/shared-dtos.js';
import { AnthropicOpenAIConverter } from '../../llmswitch-anthropic-openai.js';

export class AnthropicOpenAIConversionCodec implements ConversionCodec {
  readonly id = 'anthropic-openai';
  private readonly converter: AnthropicOpenAIConverter;
  private initialized = false;

  constructor(private readonly dependencies: ModuleDependencies) {
    // 传递成熟的配置给 AnthropicOpenAIConverter，确保与历史版本行为完全一致
    // 创建完整的 dependencies 对象，确保包含所有必需的方法
    const fullDependencies = {
      ...dependencies,
      logger: {
        ...dependencies.logger,
        // 确保 logModule 方法存在，这是 AnthropicOpenAIConverter 需要的
        logModule: (moduleId: string, action: string, data?: any) => {
          if (dependencies.logger && typeof dependencies.logger.logModule === 'function') {
            dependencies.logger.logModule(moduleId, action, data);
          }
        },
        // 保留其他可能需要的日志方法
        logTransformation: (id: string, type: string, input: any, output: any) => {
          if (dependencies.logger && typeof dependencies.logger.logTransformation === 'function') {
            dependencies.logger.logTransformation(id, type, input, output);
          }
        }
      }
    };

    this.converter = new AnthropicOpenAIConverter(
      {
        type: 'llmswitch-anthropic-openai',
        config: {
          enableStreaming: true,        // 启用流式转换
          enableTools: true,           // 启用工具转换
          trustSchema: true,           // 信任提供的 schema，与历史版本一致
          conversionMappings: {       // 保留原有的转换映射配置
            request: {
              mappings: []
            },
            response: {
              mappings: []
            }
          }
        }
      },
      fullDependencies
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.converter.initialize();
    this.initialized = true;
  }

  async convertRequest(payload: any, profile: ConversionProfile, context: ConversionContext): Promise<any> {
    await this.ensureInit();
    const dto: SharedPipelineRequest = {
      data: payload,
      route: {
        providerId: 'unknown',
        modelId: (payload && typeof payload === 'object' && (payload as any).model) ? String((payload as any).model) : 'unknown',
        requestId: context.requestId ?? `req_${Date.now()}`,
        timestamp: Date.now()
      },
      metadata: {
        endpoint: context.endpoint ?? context.entryEndpoint,
        entryEndpoint: context.entryEndpoint,
        targetProtocol: profile.outgoingProtocol,
        originalProtocol: profile.incomingProtocol
      },
      debug: { enabled: false, stages: {} }
    };
    const transformed = await this.converter.processIncoming(dto);
    return transformed.data;
  }

  async convertResponse(payload: any, profile: ConversionProfile, context: ConversionContext): Promise<any> {
    await this.ensureInit();
    const dto: SharedPipelineResponse = {
      data: payload,
      metadata: {
        requestId: context.requestId ?? `req_${Date.now()}`,
        pipelineId: context.metadata?.pipelineId as string ?? 'conversion-router',
        processingTime: 0,
        stages: []
      }
    } as SharedPipelineResponse;
    const transformed = await this.converter.processOutgoing(dto);
    if (transformed && typeof transformed === 'object' && 'data' in transformed) {
      return (transformed as SharedPipelineResponse).data;
    }
    return transformed;
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}
// (removed duplicate class definition)
