/**
 * Qwen Compatibility Module
 *
 * Translates between OpenAI-compatible requests/responses and Qwen's API
 * payloads. The implementation keeps the public surface area of the previous
 * version but removes the untyped instrumentation in favour of strictly typed
 * helpers so the module can participate in the lint clean-up.
 */

import type {
  ModuleConfig,
  TransformationRule
} from '../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ModuleDependencies } from '../../modules/pipeline/types/module.types.js';
import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';
import type { CompatibilityContext, CompatibilityModule } from './compatibility-interface.js';
import {
  TransformationEngine,
  type TransformationResult
} from '../../modules/pipeline/utils/transformation-engine.js';

type QwenMessageChunk = Record<string, unknown>;
type QwenToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export class QwenCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'chat:qwen';
  readonly providerType = 'openai';

  private readonly dependencies: ModuleDependencies;
  private _config: ModuleConfig = {
    type: 'chat:qwen',
    config: {}
  };
  private transformationEngine: TransformationEngine | null = null;
  private _rules: TransformationRule[] = [];
  private isInitialized = false;

  constructor(dependencies: ModuleDependencies) {
    this.dependencies = dependencies;
    this.id = `chat-qwen-${Date.now()}`;
  }

  get config(): ModuleConfig {
    return this._config;
  }

  get rules(): TransformationRule[] {
    return this._rules;
  }

  setConfig(config: ModuleConfig): void {
    this._config = config;
  }

  async initialize(): Promise<void> {
    this.dependencies.logger?.logModule(this.id, 'initializing', {
      providerType: this.providerType
    });

    this.transformationEngine = new TransformationEngine();
    await this.transformationEngine.initialize();
    this._rules = this.initializeTransformationRules();
    this.isInitialized = true;

    this.dependencies.logger?.logModule(this.id, 'initialized', {
      ruleCount: this.rules.length
    });
  }

  async processIncoming(
    requestParam: UnknownObject,
    _context: CompatibilityContext
  ): Promise<UnknownObject> {
    this.ensureInitialized();
    const payload = isRecord(requestParam) ? requestParam : {};
    const transformed = await this.applyRules(payload, this.rules);
    const converted = this.convertToQwenRequest(transformed);

    this.dependencies.logger?.logModule(this.id, 'transform-request-success', {
      hasTools: Array.isArray((payload as { tools?: unknown }).tools),
      ruleCount: this.rules.length
    });

    return converted;
  }

  async processOutgoing(
    responseParam: UnknownObject,
    _context: CompatibilityContext
  ): Promise<UnknownObject> {
    this.ensureInitialized();
    const payload = isRecord(responseParam) ? responseParam : {};
    const transformed = this.transformQwenResponseToOpenAI(payload);

    this.dependencies.logger?.logModule(this.id, 'transform-response-success', {
      hasChoices: Array.isArray((transformed as { choices?: unknown[] }).choices)
    });

    return transformed;
  }

  async cleanup(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }
    await this.transformationEngine?.cleanup();
    this.transformationEngine = null;
    this.isInitialized = false;
    this.dependencies.logger?.logModule(this.id, 'cleanup-complete');
  }

  getStatus(): {
    id: string;
    type: string;
    isInitialized: boolean;
    ruleCount: number;
    lastActivity: number;
  } {
    return {
      id: this.id,
      type: this.type,
      isInitialized: this.isInitialized,
      ruleCount: this.rules.length,
      lastActivity: Date.now()
    };
  }

  async getMetrics(): Promise<UnknownObject> {
    return {
      ruleCount: this.rules.length,
      initialized: this.isInitialized,
      timestamp: Date.now()
    };
  }

  async applyTransformations(data: unknown, rules: TransformationRule[]): Promise<UnknownObject> {
    this.ensureInitialized();
    const payload = isRecord(data) ? data : {};
    return this.applyRules(payload, rules);
  }

  // Helpers ----------------------------------------------------------------

  private ensureInitialized(): void {
    if (!this.isInitialized || !this.transformationEngine) {
      throw new Error('Qwen Compatibility module is not initialized');
    }
  }

  private async applyRules(data: UnknownObject, rules: TransformationRule[]): Promise<UnknownObject> {
    if (!this.transformationEngine) {
      return data;
    }
    const result = await this.transformationEngine.transform<UnknownObject>(data, rules);
    return this.extractTransformationResult(result);
  }

  private initializeTransformationRules(): TransformationRule[] {
    const baseRules: TransformationRule[] = [
      {
        id: 'map-model-names',
        transform: 'mapping',
        sourcePath: 'model',
        targetPath: 'model',
        mapping: {
          'gpt-3.5-turbo': 'qwen-turbo',
          'gpt-4': 'qwen3-coder-plus',
          'gpt-4-turbo': 'qwen3-coder-plus',
          'gpt-4o': 'qwen3-coder-plus'
        }
      },
      {
        id: 'ensure-tools-format',
        transform: 'mapping',
        sourcePath: 'tools',
        targetPath: 'tools',
        mapping: {
          type: 'type',
          function: 'function'
        }
      },
      {
        id: 'map-stream-parameter',
        transform: 'mapping',
        sourcePath: 'stream',
        targetPath: 'stream',
        mapping: {
          true: true,
          false: false
        }
      }
    ];

    const configPayload = this._config?.config;
    const customRules = isRecord(configPayload) ? configPayload.customRules : undefined;
    if (Array.isArray(customRules)) {
      baseRules.push(...customRules as TransformationRule[]);
    }

    this.dependencies.logger?.logModule(this.id, 'transformation-rules-initialized', {
      ruleCount: baseRules.length
    });
    return baseRules;
  }

  private convertToQwenRequest(request: UnknownObject): UnknownObject {
    const qwenRequest: UnknownObject = {};
    const model = typeof request.model === 'string' ? request.model : undefined;
    if (model) {
      qwenRequest.model = model;
    }

    const messages = Array.isArray(request.messages) ? request.messages : [];
    if (messages.length > 0) {
      const normalizedMessages = messages
        .map(message => this.normalizeMessage(message))
        .filter((msg): msg is { role: string; content: QwenMessageChunk[] } => msg !== null);
      if (normalizedMessages.length > 0) {
        qwenRequest.messages = messages;
        qwenRequest.input = normalizedMessages;
      }
    }

    const parameters = this.extractParameters(request);
    if (Object.keys(parameters).length > 0) {
      qwenRequest.parameters = parameters;
    }

    if (typeof request.stream === 'boolean') {
      qwenRequest.stream = request.stream;
    }
    if (isRecord(request.response_format)) {
      qwenRequest.response_format = request.response_format;
    }
    if (typeof request.user === 'string') {
      qwenRequest.user = request.user;
    }
    if (Array.isArray(request.tools)) {
      qwenRequest.tools = request.tools;
    }
    if (isRecord(request.metadata)) {
      qwenRequest.metadata = request.metadata;
    }

    return qwenRequest;
  }

  private normalizeMessage(message: unknown): { role: string; content: QwenMessageChunk[] } | null {
    if (!isRecord(message)) {
      return null;
    }
    const role = typeof message.role === 'string' ? message.role : 'user';
    const content = this.normalizeMessageContent(message.content);
    return { role, content };
  }

  private extractParameters(request: UnknownObject): Record<string, unknown> {
    const parameters: Record<string, unknown> = {};
    const numericFields: Array<{ key: keyof typeof request; target: string }> = [
      { key: 'temperature', target: 'temperature' },
      { key: 'top_p', target: 'top_p' },
      { key: 'frequency_penalty', target: 'frequency_penalty' },
      { key: 'presence_penalty', target: 'presence_penalty' },
      { key: 'max_tokens', target: 'max_output_tokens' }
    ];

    for (const field of numericFields) {
      const value = request[field.key];
      if (typeof value === 'number') {
        parameters[field.target] = value;
      }
    }

    if (request.stop !== undefined) {
      const stops = Array.isArray(request.stop) ? request.stop : [request.stop];
      parameters.stop_sequences = stops.filter(item => typeof item === 'string');
    }
    if (typeof request.debug === 'boolean') {
      parameters.debug = request.debug;
    }
    return parameters;
  }

  private normalizeMessageContent(content: unknown): QwenMessageChunk[] {
    if (content === undefined || content === null) {
      return [{ text: '' }];
    }
    if (typeof content === 'string') {
      return [{ text: content }];
    }
    if (Array.isArray(content)) {
      return content.map(item => this.normalizeContentChunk(item));
    }
    if (isRecord(content) && typeof content.text === 'string') {
      return [{ text: content.text }];
    }
    return [{ text: JSON.stringify(content) }];
  }

  private normalizeContentChunk(chunk: unknown): QwenMessageChunk {
    if (typeof chunk === 'string') {
      return { text: chunk };
    }
    if (isRecord(chunk)) {
      if (typeof chunk.text === 'string') {
        return { text: chunk.text };
      }
      return chunk;
    }
    return { text: String(chunk) };
  }

  private transformQwenResponseToOpenAI(response: UnknownObject): UnknownObject {
    const data = isRecord(response.data) ? response.data as UnknownObject : response;
    const usage = isRecord(data.usage) ? data.usage : {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    };

    const transformed: UnknownObject = {
      id: typeof data.id === 'string' ? data.id : `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: typeof data.created === 'number' ? data.created : Date.now(),
      model: typeof data.model === 'string' ? data.model : 'qwen-turbo',
      choices: this.transformChoices(data.choices),
      usage,
      _transformed: true,
      _originalFormat: 'qwen',
      _targetFormat: 'openai'
    };

    return transformed;
  }

  private transformChoices(rawChoices: unknown): UnknownObject[] {
    if (!Array.isArray(rawChoices)) {
      return [];
    }
    return rawChoices.map((choice, index) => {
      const choiceObj = isRecord(choice) ? choice : {};
      const messageObj = isRecord(choiceObj.message) ? choiceObj.message : {};
      return {
        index: typeof choiceObj.index === 'number' ? choiceObj.index : index,
        message: {
          role: typeof messageObj.role === 'string' ? messageObj.role : 'assistant',
          content: typeof messageObj.content === 'string' ? messageObj.content : '',
          tool_calls: this.transformToolCalls(messageObj.tool_calls)
        },
        finish_reason: this.transformFinishReason(
          typeof choiceObj.finish_reason === 'string' ? choiceObj.finish_reason : undefined
        )
      };
    });
  }

  private transformToolCalls(toolCalls: unknown): QwenToolCall[] {
    if (!Array.isArray(toolCalls)) {
      return [];
    }
    return toolCalls.map((toolCall, index) => {
      const toolCallObj = isRecord(toolCall) ? toolCall : {};
      const fnObj = isRecord(toolCallObj.function) ? toolCallObj.function : {};
      const id = typeof toolCallObj.id === 'string'
        ? toolCallObj.id
        : `call_${Date.now()}_${index}`;
      const name = typeof fnObj.name === 'string' ? fnObj.name : '';
      const args = typeof fnObj.arguments === 'string'
        ? fnObj.arguments
        : JSON.stringify(fnObj.arguments ?? {});
      return {
        id,
        type: 'function',
        function: { name, arguments: args }
      };
    });
  }

  private transformFinishReason(finishReason: string | undefined): string {
    const reasonMap: Record<string, string> = {
      stop: 'stop',
      length: 'length',
      tool_calls: 'tool_calls',
      content_filter: 'content_filter'
    };
    if (!finishReason) {
      return 'stop';
    }
    return reasonMap[finishReason] ?? finishReason;
  }

  private extractTransformationResult(result: TransformationResult<UnknownObject> | UnknownObject): UnknownObject {
    if (isRecord(result) && 'data' in result && isRecord(result.data)) {
      return result.data;
    }
    return isRecord(result) ? result : {};
  }
}
