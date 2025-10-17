/**
 * Models Handler Implementation
 * Handles model listing requests for all protocols
 */

import { type Request, type Response } from 'express';
import { BaseHandler, type ProtocolHandlerConfig } from './base-handler.js';
import { RouteCodexError } from '../types.js';

/**
 * Model information interface
 */
export interface ModelInfo {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  permission?: any[];
  root?: string;
  parent?: string;
  capabilities?: {
    text_completion?: boolean;
    chat_completion?: boolean;
    embedding?: boolean;
    image_generation?: boolean;
    vision?: boolean;
    tool_calling?: boolean;
    streaming?: boolean;
  };
  pricing?: {
    prompt: number;
    completion: number;
    currency?: string;
  };
  context_window?: number;
  max_output_tokens?: number;
  training_cutoff?: string;
}

/**
 * Models Handler
 * Handles /v1/models endpoint for all protocol compatibility
 */
export class ModelsHandler extends BaseHandler {
  private availableModels: ModelInfo[];

  constructor(config: ProtocolHandlerConfig, models?: ModelInfo[]) {
    super(config);
    this.availableModels = models || this.getDefaultModels();
  }

  /**
   * Handle models request
   */
  async handleRequest(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = this.generateRequestId();

    this.logger.logModule('ModelsHandler', 'request_start', {
      requestId,
      method: req.method,
      url: req.url,
      timestamp: startTime,
    });

    try {
      // Validate request
      // Process request
      const response = await this.processModelsRequest(req, requestId);

      // Return JSON response
      this.sendJsonResponse(res, response, requestId);

      this.logCompletion(requestId, startTime, true);
    } catch (error) {
      this.logCompletion(requestId, startTime, false);
      await this.handleError(error as Error, res, requestId);
    }
  }

  /**
   * Process models request
   */
  private async processModelsRequest(req: Request, requestId: string): Promise<{ object: string; data: ModelInfo[] } | ModelInfo> {
    // Check if requesting specific model
    if (req.params.model) {
      return this.getSpecificModel(req.params.model);
    }

    // Return all available models
    return this.getAllModels();
  }

  /**
   * Get specific model information
   */
  private getSpecificModel(modelId: string): ModelInfo {
    const model = this.availableModels.find(m => m.id === modelId);

    if (!model) {
      throw new RouteCodexError(
        `Model '${modelId}' not found`,
        'model_not_found',
        404
      );
    }

    return model;
  }

  /**
   * Get all available models
   */
  private getAllModels(): { data: ModelInfo[]; object: string } {
    return {
      object: 'list',
      data: this.availableModels
    };
  }

  /**
   * Get default models
   */
  private getDefaultModels(): ModelInfo[] {
    const now = Math.floor(Date.now() / 1000);

    return [
      // OpenAI-compatible models
      {
        id: 'gpt-4o',
        object: 'model',
        created: now,
        owned_by: 'openai',
        capabilities: {
          text_completion: false,
          chat_completion: true,
          embedding: false,
          image_generation: false,
          vision: true,
          tool_calling: true,
          streaming: true,
        },
        context_window: 128000,
        max_output_tokens: 4096,
        training_cutoff: '2024-06',
      },
      {
        id: 'gpt-4o-mini',
        object: 'model',
        created: now,
        owned_by: 'openai',
        capabilities: {
          text_completion: false,
          chat_completion: true,
          embedding: false,
          image_generation: false,
          vision: false,
          tool_calling: true,
          streaming: true,
        },
        context_window: 128000,
        max_output_tokens: 16384,
        training_cutoff: '2024-06',
      },
      {
        id: 'gpt-3.5-turbo',
        object: 'model',
        created: now,
        owned_by: 'openai',
        capabilities: {
          text_completion: false,
          chat_completion: true,
          embedding: false,
          image_generation: false,
          vision: false,
          tool_calling: true,
          streaming: true,
        },
        context_window: 16385,
        max_output_tokens: 4096,
        training_cutoff: '2024-06',
      },
      {
        id: 'text-davinci-003',
        object: 'model',
        created: now,
        owned_by: 'openai',
        capabilities: {
          text_completion: true,
          chat_completion: false,
          embedding: false,
          image_generation: false,
          vision: false,
          tool_calling: false,
          streaming: true,
        },
        context_window: 4097,
        max_output_tokens: 4096,
        training_cutoff: '2024-06',
      },
      // Anthropic-compatible models
      {
        id: 'claude-3-5-sonnet-20241022',
        object: 'model',
        created: now,
        owned_by: 'anthropic',
        capabilities: {
          text_completion: false,
          chat_completion: true,
          embedding: false,
          image_generation: false,
          vision: true,
          tool_calling: true,
          streaming: true,
        },
        context_window: 200000,
        max_output_tokens: 8192,
        training_cutoff: '2024-04',
      },
      {
        id: 'claude-3-5-haiku-20241022',
        object: 'model',
        created: now,
        owned_by: 'anthropic',
        capabilities: {
          text_completion: false,
          chat_completion: true,
          embedding: false,
          image_generation: false,
          vision: true,
          tool_calling: true,
          streaming: true,
        },
        context_window: 200000,
        max_output_tokens: 8192,
        training_cutoff: '2024-04',
      },
      {
        id: 'claude-3-opus-20240229',
        object: 'model',
        created: now,
        owned_by: 'anthropic',
        capabilities: {
          text_completion: false,
          chat_completion: true,
          embedding: false,
          image_generation: false,
          vision: true,
          tool_calling: true,
          streaming: true,
        },
        context_window: 200000,
        max_output_tokens: 4096,
        training_cutoff: '2024-04',
      },
      // Local/Custom models
      {
        id: 'llama-3.1-8b-instruct',
        object: 'model',
        created: now,
        owned_by: 'meta',
        capabilities: {
          text_completion: false,
          chat_completion: true,
          embedding: false,
          image_generation: false,
          vision: false,
          tool_calling: true,
          streaming: true,
        },
        context_window: 128000,
        max_output_tokens: 4096,
        training_cutoff: '2024-06',
      },
      {
        id: 'llama-3.1-70b-instruct',
        object: 'model',
        created: now,
        owned_by: 'meta',
        capabilities: {
          text_completion: false,
          chat_completion: true,
          embedding: false,
          image_generation: false,
          vision: false,
          tool_calling: true,
          streaming: true,
        },
        context_window: 128000,
        max_output_tokens: 8192,
        training_cutoff: '2024-06',
      },
      {
        id: 'qwen2.5-7b-instruct',
        object: 'model',
        created: now,
        owned_by: 'alibaba',
        capabilities: {
          text_completion: false,
          chat_completion: true,
          embedding: false,
          image_generation: false,
          vision: false,
          tool_calling: true,
          streaming: true,
        },
        context_window: 32768,
        max_output_tokens: 8192,
        training_cutoff: '2024-06',
      },
      // Embedding models
      {
        id: 'text-embedding-3-small',
        object: 'model',
        created: now,
        owned_by: 'openai',
        capabilities: {
          text_completion: false,
          chat_completion: false,
          embedding: true,
          image_generation: false,
          vision: false,
          tool_calling: false,
          streaming: false,
        },
        context_window: 8191,
        max_output_tokens: 0,
        training_cutoff: '2024-06',
      },
      {
        id: 'text-embedding-3-large',
        object: 'model',
        created: now,
        owned_by: 'openai',
        capabilities: {
          text_completion: false,
          chat_completion: false,
          embedding: true,
          image_generation: false,
          vision: false,
          tool_calling: false,
          streaming: false,
        },
        context_window: 8191,
        max_output_tokens: 0,
        training_cutoff: '2024-06',
      },
    ];
  }

  /**
   * Update available models
   */
  public updateModels(models: ModelInfo[]): void {
    this.availableModels = models;
    this.logger.logModule('ModelsHandler', 'models_updated', {
      count: models.length,
      modelIds: models.map(m => m.id),
    });
  }

  /**
   * Add a new model
   */
  public addModel(model: ModelInfo): void {
    const existingIndex = this.availableModels.findIndex(m => m.id === model.id);
    if (existingIndex >= 0) {
      this.availableModels[existingIndex] = model;
    } else {
      this.availableModels.push(model);
    }

    this.logger.logModule('ModelsHandler', 'model_added', {
      modelId: model.id,
      ownedBy: model.owned_by,
    });
  }

  /**
   * Remove a model
   */
  public removeModel(modelId: string): boolean {
    const initialLength = this.availableModels.length;
    this.availableModels = this.availableModels.filter(m => m.id !== modelId);
    const removed = this.availableModels.length < initialLength;

    if (removed) {
      this.logger.logModule('ModelsHandler', 'model_removed', {
        modelId,
      });
    }

    return removed;
  }

  /**
   * Get models by capability
   */
  public getModelsByCapability(capability: keyof ModelInfo['capabilities']): ModelInfo[] {
    return this.availableModels.filter(model =>
      model.capabilities && model.capabilities[capability] === true
    );
  }

  /**
   * Get models by owner
   */
  public getModelsByOwner(owner: string): ModelInfo[] {
    return this.availableModels.filter(model => model.owned_by === owner);
  }
}
