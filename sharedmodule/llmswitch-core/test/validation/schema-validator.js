/**
 * Schema-first形状验证器
 * 用于验证Responses协议的请求和响应形状正确性
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

/**
 * JSON Schema定义 - Responses协议（历史格式）
 */
const RESPONSES_REQUEST_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['model', 'input'],
  properties: {
    model: {
      type: 'string',
      description: '模型名称'
    },
    input: {
      type: 'array',
      minItems: 1,
      items: {
        $ref: '#/definitions/ResponsesInput'
      },
      description: 'Responses输入列表'
    },
    tools: {
      type: 'array',
      items: {
        $ref: '#/definitions/ResponsesTool'
      },
      description: '可用工具列表'
    },
    temperature: {
      type: 'number',
      minimum: 0,
      maximum: 2,
      description: '温度参数'
    },
    top_p: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Top-p参数'
    },
    max_output_tokens: {
      type: 'integer',
      minimum: 1,
      description: '最大输出token数'
    },
    metadata: {
      type: 'object',
      description: '元数据'
    },
    store: {
      type: 'boolean',
      description: '是否存储响应'
    },
    truncation: {
      type: 'string',
      enum: ['auto', 'disabled'],
      description: '截断策略'
    },
    user: {
      type: 'string',
      description: '用户标识'
    },
    include: {
      type: 'array',
      items: {
        type: 'string'
      },
      description: '包含的用户信息字段'
    },
    parallel_tool_calls: {
      type: 'boolean',
      description: '是否允许并行工具调用'
    },
    previous_response_id: {
      type: 'string',
      description: '前置响应ID'
    },
    reasoning: {
      $ref: '#/definitions/ResponsesReasoningConfig',
      description: '推理配置'
    },
    stream: {
      type: 'boolean',
      description: '是否启用流式响应'
    },
  },
  definitions: {
    // Responses输入定义
    ResponsesInput: {
      type: 'object',
      required: ['role', 'content'],
      properties: {
        role: {
          type: 'string',
          enum: ['user', 'assistant', 'system'],
          description: '消息角色'
        },
        content: {
          type: 'array',
          items: {
            $ref: '#/definitions/ResponsesContent'
          },
          description: 'Responses内容数组'
        },
        name: {
          type: 'string',
          description: '消息名称'
        }
      }
    },

    // Responses内容定义
    ResponsesContent: {
      type: 'object',
      required: ['type'],
      oneOf: [
        {
          type: 'object',
          required: ['type', 'text'],
          properties: {
            type: { const: 'input_text' },
            text: { type: 'string' }
          }
        },
        {
          type: 'object',
          required: ['type', 'text'],
          properties: {
            type: { const: 'output_text' },
            text: { type: 'string' }
          }
        },
        {
          type: 'object',
          required: ['type', 'image_url'],
          properties: {
            type: { const: 'input_image' },
            image_url: { type: 'string' },
            detail: { type: 'string', enum: ['auto', 'low', 'high'] }
          }
        },
        {
          type: 'object',
          required: ['type', 'name', 'arguments'],
          properties: {
            type: { const: 'function_call' },
            name: { type: 'string' },
            arguments: { type: 'string' }
          }
        },
        {
          type: 'object',
          required: ['type', 'result', 'tool_call_id'],
          properties: {
            type: { const: 'function_result' },
            result: {},
            tool_call_id: { type: 'string' }
          }
        },
        {
          type: 'object',
          required: ['type', 'file_search'],
          properties: {
            type: { const: 'file_search' },
            file_search: {}
          }
        },
        {
          type: 'object',
          required: ['type', 'computer_use'],
          properties: {
            type: { const: 'computer_use' },
            computer_use: {}
          }
        },
        {
          type: 'object',
          required: ['type', 'conversation'],
          properties: {
            type: { const: 'conversation' },
            conversation: {
              type: 'array',
              items: {}
            }
          }
        }
      ]
    },

    // Responses工具定义 - 基于responses-types.ts:134
    ResponsesTool: {
      type: 'object',
      required: ['type', 'name'],
      properties: {
        type: { const: 'function' },
        name: { type: 'string' },
        description: { type: 'string' }, // 可选字段，见responses-types.ts:137
        parameters: { type: 'object' },
        strict: { type: 'boolean' }
      }
    },

    // Responses推理配置
    ResponsesReasoningConfig: {
      type: 'object',
      required: ['max_tokens'],
      properties: {
        max_tokens: { type: 'integer', minimum: 1 },
        summarize: { type: 'boolean' },
        summarize_threshold: { type: 'integer' }
      }
    },

    // Responses输出项定义
    ResponsesOutputItem: {
      type: 'object',
      required: ['type', 'id'],
      oneOf: [
        {
          type: 'object',
          required: ['type', 'id', 'status', 'role', 'content'],
          properties: {
            type: { const: 'message' },
            id: { type: 'string' },
            status: { type: 'string', enum: ['in_progress', 'completed'] },
            role: { const: 'assistant' },
            content: {
              type: 'array',
              items: { $ref: '#/definitions/ResponsesContent' }
            }
          }
        },
        {
          type: 'object',
          required: ['type', 'id', 'content'],
          properties: {
            type: { const: 'reasoning' },
            id: { type: 'string' },
            content: {
              type: 'array',
              items: { $ref: '#/definitions/ResponsesReasoningContent' }
            },
            summary: {
              type: 'array',
              items: { type: 'string' }
            }
          }
        },
        {
          type: 'object',
          required: ['type', 'id', 'status', 'call_id', 'name', 'arguments'],
          properties: {
            type: { const: 'function_call' },
            id: { type: 'string' },
            status: { type: 'string', enum: ['in_progress', 'completed'] },
            call_id: { type: 'string' },
            name: { type: 'string' },
            arguments: { type: 'string' }
          }
        },
        {
          type: 'object',
          required: ['type', 'id', 'call_id', 'output'],
          properties: {
            type: { const: 'function_call_output' },
            id: { type: 'string' },
            call_id: { type: 'string' },
            output: {}
          }
        },
        {
          type: 'object',
          required: ['type', 'id', 'name', 'data'],
          properties: {
            type: { const: 'system' },
            id: { type: 'string' },
            name: { type: 'string' },
            data: {}
          }
        }
      ]
    },

    // Responses推理内容
    ResponsesReasoningContent: {
      type: 'object',
      required: ['type'],
      oneOf: [
        {
          type: 'object',
          required: ['type', 'text'],
          properties: {
            type: { const: 'reasoning_text' },
            text: { type: 'string' }
          }
        },
        {
          type: 'object',
          required: ['type', 'signature'],
          properties: {
            type: { const: 'reasoning_signature' },
            signature: {}
          }
        },
        {
          type: 'object',
          required: ['type', 'image_url'],
          properties: {
            type: { const: 'reasoning_image' },
            image_url: { type: 'string' }
          }
        }
      ]
    },

    // Responses必需动作
    ResponsesRequiredAction: {
      type: 'object',
      required: ['type'],
      oneOf: [
        {
          type: 'object',
          required: ['type', 'submit_tool_outputs'],
          properties: {
            type: { const: 'submit_tool_outputs' },
            submit_tool_outputs: {
              type: 'object',
              required: ['tool_calls'],
              properties: {
                tool_calls: {
                  type: 'array',
                  items: { $ref: '#/definitions/ResponsesToolCall' }
                }
              }
            }
          }
        },
        {
          type: 'object',
          required: ['type', 'run_parallel_tools'],
          properties: {
            type: { const: 'run_parallel_tools' },
            run_parallel_tools: {
              type: 'object',
              required: ['tool_calls'],
              properties: {
                tool_calls: {
                  type: 'array',
                  items: { $ref: '#/definitions/ResponsesToolCall' }
                }
              }
            }
          }
        }
      ]
    },

    // Responses工具调用
    ResponsesToolCall: {
      type: 'object',
      required: ['id', 'type', 'function'],
      properties: {
        id: { type: 'string' },
        type: { const: 'function' },
        function: {
          type: 'object',
          required: ['name', 'arguments'],
          properties: {
            name: { type: 'string' },
            arguments: { type: 'string' }
          }
        }
      }
    },

    // Responses使用量
    ResponsesUsage: {
      type: 'object',
      required: ['input_tokens', 'output_tokens', 'total_tokens'],
      properties: {
        input_tokens: { type: 'integer', minimum: 0 },
        output_tokens: { type: 'integer', minimum: 0 },
        total_tokens: { type: 'integer', minimum: 0 },
        input_tokens_details: {
          type: 'object',
          properties: {
            cached_tokens: { type: 'integer', minimum: 0 },
            audio_tokens: { type: 'integer', minimum: 0 },
            text_tokens: { type: 'integer', minimum: 0 },
            image_tokens: { type: 'integer', minimum: 0 }
          }
        },
        output_tokens_details: {
          type: 'object',
          properties: {
            reasoning_tokens: { type: 'integer', minimum: 0 },
            audio_tokens: { type: 'integer', minimum: 0 },
            text_tokens: { type: 'integer', minimum: 0 }
          }
        }
      }
    },

    // 错误定义
    Error: {
      type: 'object',
      required: ['type', 'message'],
      properties: {
        type: { type: 'string' },
        message: { type: 'string' }
      }
    }
  }
};

const RESPONSES_RESPONSE_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['id', 'object', 'created_at', 'status', 'output'],
  properties: {
    id: {
      type: 'string',
      description: '响应ID'
    },
    object: {
      type: 'string',
      enum: ['response'],
      description: '对象类型'
    },
    created_at: {
      type: 'integer',
      description: '创建时间戳'
    },
    model: {
      type: 'string',
      description: '模型名称'
    },
    status: {
      type: 'string',
      enum: ['in_progress', 'requires_action', 'completed', 'failed', 'incomplete'],
      description: '响应状态'
    },
    output: {
      type: 'array',
      items: {
        $ref: '#/definitions/ResponsesOutputItem'
      },
      description: '输出内容数组'
    },
    required_action: {
      $ref: '#/definitions/ResponsesRequiredAction',
      description: '必需动作'
    },
    error: {
      $ref: '#/definitions/Error'
    },
    usage: {
      $ref: '#/definitions/ResponsesUsage'
    },
    temperature: {
      type: 'number',
      description: '温度参数'
    },
    top_p: {
      type: 'number',
      description: 'Top-p参数'
    },
    max_output_tokens: {
      type: 'integer',
      description: '最大输出token数'
    },
    previous_response_id: {
      type: 'string',
      description: '前置响应ID'
    },
    metadata: {
      type: 'object',
      description: '元数据'
    },
    user: {
      type: 'string',
      description: '用户标识'
    },
    store: {
      type: 'boolean',
      description: '是否存储响应'
    },
    truncation: {
      type: 'string',
      enum: ['auto', 'disabled'],
      description: '截断策略'
    },
    include: {
      type: 'array',
      items: {
        type: 'string'
      },
      description: '包含的用户信息字段'
    },
    parallel_tool_calls: {
      type: 'boolean',
      description: '是否允许并行工具调用'
    }
  }
};

/**
 * Schema验证器类
 */
class SchemaValidator {
  constructor() {
    this.ajv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false
    });

    // 添加格式支持
    addFormats(this.ajv);

    // 编译schemas
    this.requestValidator = this.ajv.compile(RESPONSES_REQUEST_SCHEMA);
    this.responseValidator = this.ajv.compile(RESPONSES_RESPONSE_SCHEMA);

    // 自定义验证规则
    this.customRules = new Map();
  }

  /**
   * 验证请求
   */
  validateRequest(request) {
    const result = {
      valid: false,
      errors: [],
      warnings: []
    };

    try {
      // 基础schema验证
      const isValid = this.requestValidator(request);
      result.valid = isValid;

      if (!isValid) {
        result.errors = this.formatErrors(this.requestValidator.errors);
      }

      // 自定义规则验证
      const customResult = this.runCustomRules(request, 'request');
      result.errors.push(...customResult.errors);
      result.warnings.push(...customResult.warnings);

      // 检查工具定义 (Responses格式)
      if (request.tools) {
        const toolValidation = this.validateResponsesTools(request.tools);
        result.errors.push(...toolValidation.errors);
        result.warnings.push(...toolValidation.warnings);
      }

      // 检查消息结构
      if (request.input) {
        const messageValidation = this.validateMessages(request.input);
        result.errors.push(...messageValidation.errors);
        result.warnings.push(...messageValidation.warnings);
      }

    } catch (error) {
      result.valid = false;
      result.errors.push({
        field: 'schema',
        message: `Schema validation error: ${error.message}`,
        value: error
      });
    }

    return result;
  }

  /**
   * 验证响应
   */
  validateResponse(response) {
    const result = {
      valid: false,
      errors: [],
      warnings: []
    };

    try {
      // 基础schema验证
      const isValid = this.responseValidator(response);
      result.valid = isValid;

      if (!isValid) {
        result.errors = this.formatErrors(this.responseValidator.errors);
      }

      // 自定义规则验证
      const customResult = this.runCustomRules(response, 'response');
      result.errors.push(...customResult.errors);
      result.warnings.push(...customResult.warnings);

      // 检查输出结构
      if (response.output) {
        const outputValidation = this.validateOutput(response.output);
        result.errors.push(...outputValidation.errors);
        result.warnings.push(...outputValidation.warnings);
      }

      // 检查使用情况
      if (response.usage) {
        const usageValidation = this.validateUsage(response.usage);
        result.errors.push(...usageValidation.errors);
        result.warnings.push(...usageValidation.warnings);
      }

    } catch (error) {
      result.valid = false;
      result.errors.push({
        field: 'schema',
        message: `Schema validation error: ${error.message}`,
        value: error
      });
    }

    return result;
  }

  /**
   * 验证Responses协议工具定义
   * 基于 responses-types.ts:134
   */
  validateResponsesTools(tools) {
    const result = { errors: [], warnings: [] };

    if (!Array.isArray(tools)) {
      result.errors.push({
        field: 'tools',
        message: 'Tools must be an array',
        value: tools
      });
      return result;
    }

    tools.forEach((tool, index) => {
      // 验证基本字段
      if (!tool.type || tool.type !== 'function') {
        result.errors.push({
          field: `tools[${index}].type`,
          message: 'Tool type must be "function"',
          value: tool.type
        });
      }

      if (!tool.name || typeof tool.name !== 'string') {
        result.errors.push({
          field: `tools[${index}].name`,
          message: 'Tool name is required and must be a string',
          value: tool.name
        });
      }

      // description字段在responses-types.ts:137中是可选的
      if (tool.description && typeof tool.description !== 'string') {
        result.errors.push({
          field: `tools[${index}].description`,
          message: 'Tool description must be a string if provided',
          value: tool.description
        });
      }

      // strict字段是可选的布尔值
      if (tool.strict !== undefined && typeof tool.strict !== 'boolean') {
        result.errors.push({
          field: `tools[${index}].strict`,
          message: 'Tool strict must be a boolean if provided',
          value: tool.strict
        });
      }

      // 验证参数schema (可选)
      if (tool.parameters) {
        if (typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) {
          result.errors.push({
            field: `tools[${index}].parameters`,
            message: 'Tool parameters must be an object if provided',
            value: tool.parameters
          });
        } else {
          const paramValidation = this.validateParametersSchema(tool.parameters, index);
          result.errors.push(...paramValidation.errors);
          result.warnings.push(...paramValidation.warnings);
        }
      }
    });

    return result;
  }

  /**
   * 验证OpenAI格式工具定义 (用于其他协议)
   */
  validateTools(tools) {
    const result = { errors: [], warnings: [] };

    if (!Array.isArray(tools)) {
      result.errors.push({
        field: 'tools',
        message: 'Tools must be an array',
        value: tools
      });
      return result;
    }

    tools.forEach((tool, index) => {
      if (!tool.type || tool.type !== 'function') {
        result.errors.push({
          field: `tools[${index}].type`,
          message: 'Tool type must be "function"',
          value: tool.type
        });
      }

      if (!tool.function || typeof tool.function !== 'object') {
        result.errors.push({
          field: `tools[${index}].function`,
          message: 'Tool must have a function object',
          value: tool.function
        });
        return;
      }

      if (!tool.function.name || typeof tool.function.name !== 'string') {
        result.errors.push({
          field: `tools[${index}].function.name`,
          message: 'Function name is required and must be a string',
          value: tool.function.name
        });
      }

      // description字段在responses-types.ts:137中是可选的
      if (tool.function.description && typeof tool.function.description !== 'string') {
        result.errors.push({
          field: `tools[${index}].function.description`,
          message: 'Function description must be a string if provided',
          value: tool.function.description
        });
      }

      // 验证参数schema
      if (tool.function.parameters) {
        const paramValidation = this.validateParametersSchema(tool.function.parameters, index);
        result.errors.push(...paramValidation.errors);
        result.warnings.push(...paramValidation.warnings);
      }
    });

    return result;
  }

  /**
   * 验证消息结构
   */
  validateMessages(messages) {
    const result = { errors: [], warnings: [] };

    if (!Array.isArray(messages)) {
      result.errors.push({
        field: 'input',
        message: 'Input must be an array of messages',
        value: messages
      });
      return result;
    }

    if (messages.length === 0) {
      result.errors.push({
        field: 'input',
        message: 'Input cannot be empty',
        value: messages
      });
      return result;
    }

    messages.forEach((message, index) => {
      if (!message.role || !['user', 'assistant', 'system'].includes(message.role)) {
        result.errors.push({
          field: `input[${index}].role`,
          message: 'Message role is required and must be user, assistant, or system',
          value: message.role
        });
      }

      if (!message.content) {
        result.errors.push({
          field: `input[${index}].content`,
          message: 'Message content is required',
          value: message.content
        });
      }
    });

    // 检查对话流程
    const flowValidation = this.validateConversationFlow(messages);
    result.warnings.push(...flowValidation.warnings);

    return result;
  }

  /**
   * 验证输出结构
   */
  validateOutput(output) {
    const result = { errors: [], warnings: [] };

    if (!Array.isArray(output)) {
      result.errors.push({
        field: 'output',
        message: 'Output must be an array',
        value: output
      });
      return result;
    }

    if (output.length === 0) {
      result.errors.push({
        field: 'output',
        message: 'Output cannot be empty',
        value: output
      });
      return result;
    }

    output.forEach((item, index) => {
      if (!item.type) {
        result.errors.push({
          field: `output[${index}].type`,
          message: 'Output item type is required',
          value: item.type
        });
      }

      if (item.type === 'message') {
        if (!item.role || item.role !== 'assistant') {
          result.errors.push({
            field: `output[${index}].role`,
            message: 'Message output item must have role "assistant"',
            value: item.role
          });
        }

        if (!item.content || !Array.isArray(item.content)) {
          result.errors.push({
            field: `output[${index}].content`,
            message: 'Message output item must have content array',
            value: item.content
          });
        }
      }
    });

    return result;
  }

  /**
   * 验证使用情况
   */
  validateUsage(usage) {
    const result = { errors: [], warnings: [] };

    if (typeof usage !== 'object' || usage === null) {
      result.errors.push({
        field: 'usage',
        message: 'Usage must be an object',
        value: usage
      });
      return result;
    }

    ['input_tokens', 'output_tokens'].forEach(field => {
      if (usage[field] !== undefined) {
        if (typeof usage[field] !== 'number' || usage[field] < 0) {
          result.errors.push({
            field: `usage.${field}`,
            message: `${field} must be a non-negative integer`,
            value: usage[field]
          });
        }
      }
    });

    return result;
  }

  /**
   * 验证参数schema
   */
  validateParametersSchema(parameters, toolIndex) {
    const result = { errors: [], warnings: [] };

    if (parameters.type && parameters.type !== 'object') {
      result.errors.push({
        field: `tools[${toolIndex}].function.parameters.type`,
        message: 'Parameters type must be "object"',
        value: parameters.type
      });
    }

    if (parameters.properties) {
      for (const [paramName, paramDef] of Object.entries(parameters.properties)) {
        if (!paramDef.type) {
          result.errors.push({
            field: `tools[${toolIndex}].function.parameters.properties.${paramName}.type`,
            message: 'Parameter definition must have a type',
            value: paramDef
          });
        }
      }
    }

    return result;
  }

  /**
   * 验证对话流程
   */
  validateConversationFlow(messages) {
    const result = { warnings: [] };

    // 检查是否以user消息开始
    if (messages[0]?.role !== 'user') {
      result.warnings.push({
        field: 'input[0].role',
        message: 'Conversation should start with a user message',
        value: messages[0]?.role
      });
    }

    // 检查连续相同角色
    for (let i = 1; i < messages.length; i++) {
      if (messages[i].role === messages[i-1].role) {
        result.warnings.push({
          field: `input[${i}].role`,
          message: `Consecutive messages with same role: ${messages[i].role}`,
          value: messages[i].role
        });
      }
    }

    return result;
  }

  /**
   * 验证流式响应
   */
  validateStream(chunks, options = {}) {
    const result = {
      valid: false,
      errors: [],
      warnings: []
    };

    if (!Array.isArray(chunks)) {
      result.errors.push({
        field: 'chunks',
        message: 'Chunks must be an array',
        value: chunks
      });
      return result;
    }

    if (chunks.length === 0) {
      result.errors.push({
        field: 'chunks',
        message: 'Chunks array cannot be empty',
        value: chunks
      });
      return result;
    }

    try {
      // 1. 验证事件顺序
      this.validateChunkOrder(chunks, result);

      // 2. 验证事件完整性
      this.validateChunkCompleteness(chunks, result);

      // 3. 验证协议特定的流式事件
      this.validateStreamEvents(chunks, result);

      // 4. 验证内容一致性
      if (options.validateContent) {
        this.validateStreamContent(chunks, result);
      }

      result.valid = result.errors.length === 0;

    } catch (error) {
      result.valid = false;
      result.errors.push({
        field: 'stream',
        message: `Stream validation error: ${error.message}`,
        value: error
      });
    }

    return result;
  }

  /**
   * 验证块顺序
   */
  validateChunkOrder(chunks, result) {
    const sequenceNumbers = [];
    let lastSequence = -1;

    chunks.forEach((chunk, index) => {
      // 支持多种序列号字段名
      const seqNum = chunk.sequence || chunk.sequenceNumber || chunk.sequence_number;

      if (seqNum !== undefined) {
        sequenceNumbers.push(seqNum);

        if (seqNum <= lastSequence) {
          result.errors.push({
            field: `chunks[${index}].sequence`,
            message: `Chunk sequence out of order: ${seqNum} <= ${lastSequence}`,
            value: seqNum
          });
        }
        lastSequence = seqNum;
      }
    });

    // 检查序列号是否连续（从0开始应该是连续的）
    if (sequenceNumbers.length > 1) {
      const gaps = [];
      for (let i = 1; i < sequenceNumbers.length; i++) {
        const expected = sequenceNumbers[i - 1] + 1;
        if (sequenceNumbers[i] !== expected) {
          gaps.push({ at: i, expected, actual: sequenceNumbers[i] });
        }
      }

      if (gaps.length > 0) {
        result.warnings.push({
          field: 'chunks',
          message: `Sequence number gaps detected: ${gaps.map(g => `${g.actual}!=${g.expected}`).join(', ')}`,
          value: { sequenceNumbers, gaps }
        });
      }
    }
  }

  /**
   * 验证块完整性
   */
  validateChunkCompleteness(chunks, result) {
    const eventTypes = new Map();

    chunks.forEach((chunk, index) => {
      if (chunk.type) {
        eventTypes.set(chunk.type, (eventTypes.get(chunk.type) || 0) + 1);

        // 验证必需字段
        this.validateChunkFields(chunk, index, result);
      } else {
        result.errors.push({
          field: `chunks[${index}].type`,
          message: 'Chunk type is required',
          value: chunk.type
        });
      }
    });

    // 验证必需的事件类型 - 修复为协议兼容的必要事件
    const requiredEvents = [
      'response.created'
      // 'response.completed' 移除，因为其他状态如requires_action也是有效的终端状态
    ];

    requiredEvents.forEach(eventType => {
      if (!eventTypes.has(eventType)) {
        result.errors.push({
          field: 'chunks',
          message: `Missing required event type: ${eventType}`,
          value: Array.from(eventTypes.keys())
        });
      }
    });

    // 验证是否有一个有效的终端事件
    const terminalEvents = ['response.completed', 'response.failed', 'response.incomplete', 'response.requires_action', 'response.done'];
    const hasTerminalEvent = terminalEvents.some(event => eventTypes.has(event));

    if (!hasTerminalEvent) {
      result.errors.push({
        field: 'chunks',
        message: 'Stream must end with a terminal event (completed, failed, incomplete, requires_action, or done)',
        value: Array.from(eventTypes.keys())
      });
    }
  }

  /**
   * 验证流式事件
   */
  validateStreamEvents(chunks, result) {
    const eventSequence = chunks.map(c => c.type);

    // 验证标准流式序列
    const validSequences = [
      // 基础流式序列
      ['response.created', 'response.in_progress', 'response.completed', 'response.done'],
      ['response.created', 'response.in_progress', 'response.completed'],
      ['response.created', 'response.completed'],

      // 带输出文本的流式序列
      ['response.created', 'response.in_progress', 'response.output_text.delta', 'response.output_text.done', 'response.completed', 'response.done'],
      ['response.created', 'response.in_progress', 'response.output_text.delta', 'response.output_text.done', 'response.completed'],

      // 工具调用流式序列
      ['response.created', 'response.in_progress', 'response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.completed', 'response.done'],

      // 推理流式序列
      ['response.created', 'response.in_progress', 'response.reasoning_text.delta', 'response.reasoning_text.done', 'response.completed', 'response.done']
    ];

    const isValidSequence = validSequences.some(validSeq =>
      this.matchesEventSequence(eventSequence, validSeq)
    );

    if (!isValidSequence) {
      result.warnings.push({
        field: 'chunks',
        message: `Event sequence may not follow standard pattern: ${eventSequence.join(' -> ')}`,
        value: eventSequence
      });
    }

    // 验证响应状态流
    this.validateResponseStatusFlow(chunks, result);
  }

  /**
   * 验证响应状态流
   */
  validateResponseStatusFlow(chunks, result) {
    let currentStatus = null;
    let hasCompleted = false;

    chunks.forEach((chunk, index) => {
      if (chunk.type === 'response.completed' || chunk.type === 'response.failed') {
        hasCompleted = true;
      }

      if (chunk.status && currentStatus !== chunk.status) {
        // 验证状态转换是否有效
        if (currentStatus && !this.isValidStatusTransition(currentStatus, chunk.status)) {
          result.warnings.push({
            field: `chunks[${index}].status`,
            message: `Invalid status transition: ${currentStatus} -> ${chunk.status}`,
            value: { from: currentStatus, to: chunk.status }
          });
        }
        currentStatus = chunk.status;
      }
    });
  }

  /**
   * 验证流式内容
   */
  validateStreamContent(chunks, result) {
    const textContent = [];
    const toolCalls = [];
    const toolCallDeltas = [];

    chunks.forEach((chunk, index) => {
      // 从chunk.data中提取实际数据，支持多种数据格式
      const data = chunk.data || chunk;

      // 收集output_text增量
      if (chunk.type === 'response.output_text.delta') {
        const text = data?.delta || chunk.text;
        if (text !== undefined) {
          textContent.push(text);
        }
      }

      // 收集function_call_arguments增量（不解析中间状态）
      if (chunk.type === 'response.function_call_arguments.delta') {
        const args = data?.arguments || chunk.arguments;
        if (args !== undefined) {
          toolCallDeltas.push(args);
        }
      }

      // 收集完整的function_call（在done事件时）
      if (chunk.type === 'response.function_call_arguments.done') {
        const args = data?.arguments || chunk.arguments;
        if (args !== undefined) {
          toolCalls.push(args);
        }
      }
    });

    // 验证内容是否连续
    if (textContent.length > 1) {
      const combinedText = textContent.join('');
      if (combinedText.length === 0) {
        result.warnings.push({
          field: 'chunks',
          message: 'Stream text chunks produced empty content',
          value: textContent
        });
      }
    }

    // 验证工具调用参数完整性（只验证done事件中的完整参数）
    toolCalls.forEach((args, index) => {
      try {
        JSON.parse(args);
      } catch (error) {
        result.errors.push({
          field: `chunks.function_call_arguments.done[${index}].arguments`,
          message: `Invalid JSON in function call arguments: ${error.message}`,
          value: args
        });
      }
    });

    // 检查工具调用增量是否合理（不强制完整性，因为增量可能是部分数据）
    if (toolCallDeltas.length > 0) {
      result.warnings.push({
        field: 'chunks',
        message: `Found ${toolCallDeltas.length} partial function call argument chunks (this is normal for streaming)`,
        value: toolCallDeltas.length
      });
    }
  }

  /**
   * 验证块字段
   */
  validateChunkFields(chunk, index, result) {
    // 验证基础字段
    if (chunk.type && typeof chunk.type !== 'string') {
      result.errors.push({
        field: `chunks[${index}].type`,
        message: 'Chunk type must be a string',
        value: chunk.type
      });
    }

    // 验证时间戳
    if (chunk.timestamp && typeof chunk.timestamp !== 'number') {
      result.errors.push({
        field: `chunks[${index}].timestamp`,
        message: 'Chunk timestamp must be a number',
        value: chunk.timestamp
      });
    }

    // 验证协议标识
    if (chunk.protocol && chunk.protocol !== 'responses') {
      result.warnings.push({
        field: `chunks[${index}].protocol`,
        message: 'Expected protocol to be "responses"',
        value: chunk.protocol
      });
    }

    // 验证响应特定字段
    this.validateResponsesChunkFields(chunk, index, result);
  }

  /**
   * 验证Responses协议特定字段
   */
  validateResponsesChunkFields(chunk, index, result) {
    // 真实SSE事件中，内容字段在chunk.data中
    // 基于 llmswitch-core/test-output/responses/2025-11-23T03-51-33-885Z/responses-canonical-events.json
    const data = chunk.data || chunk;

    // 验证output_text事件
    if (chunk.type === 'response.output_text.delta') {
      if (data.delta === undefined || typeof data.delta !== 'string') {
        result.errors.push({
          field: `chunks[${index}].data.delta`,
          message: 'output_text.delta requires delta field in data',
          value: data.delta
        });
      }
    }

    // 验证function_call_arguments事件
    if (chunk.type === 'response.function_call_arguments.delta') {
      if (data.arguments === undefined || typeof data.arguments !== 'string') {
        result.errors.push({
          field: `chunks[${index}].data.arguments`,
          message: 'function_call_arguments.delta requires arguments field in data',
          value: data.arguments
        });
      }
    }

    // 验证required_action事件
    if (chunk.type === 'response.required_action') {
      if (!data || typeof data !== 'object') {
        result.errors.push({
          field: `chunks[${index}].data`,
          message: 'required_action event requires data object',
          value: data
        });
      }
    }
  }

  /**
   * 检查事件序列是否匹配
   */
  matchesEventSequence(actualSequence, expectedSequence) {
    let expectedIndex = 0;

    for (const event of actualSequence) {
      if (expectedIndex >= expectedSequence.length) {
        return false;
      }

      // 允许中间有其他事件，但核心事件必须按顺序出现
      if (event === expectedSequence[expectedIndex]) {
        expectedIndex++;
      }
    }

    return expectedIndex === expectedSequence.length;
  }

  /**
   * 验证状态转换
   */
  isValidStatusTransition(from, to) {
    const validTransitions = {
      'in_progress': ['completed', 'requires_action', 'failed', 'incomplete'],
      'requires_action': ['completed', 'failed', 'incomplete'],
      'completed': [],
      'failed': [],
      'incomplete': []
    };

    return !validTransitions[from] || validTransitions[from].includes(to);
  }

  /**
   * 运行自定义规则
   */
  runCustomRules(data, type) {
    const result = { errors: [], warnings: [] };

    for (const [ruleName, rule] of this.customRules) {
      try {
        if (rule.types.includes(type)) {
          const ruleResult = rule.validate(data);
          if (!ruleResult.valid) {
            result.errors.push({
              field: 'custom',
              message: `Custom rule ${ruleName} failed: ${ruleResult.message}`,
              value: data
            });
          }
        }
      } catch (error) {
        result.errors.push({
          field: 'custom',
          message: `Custom rule ${ruleName} error: ${error.message}`,
          value: error
        });
      }
    }

    return result;
  }

  /**
   * 添加自定义验证规则
   */
  addCustomRule(name, rule) {
    this.customRules.set(name, rule);
  }

  /**
   * 格式化错误信息
   */
  formatErrors(errors) {
    if (!errors) return [];

    return errors.map(error => ({
      field: error.instancePath || error.schemaPath || 'unknown',
      message: error.message || 'Validation error',
      value: error.data,
      allowedValues: error.schema?.enum || error.schema?.type
    }));
  }
}

export {
  SchemaValidator,
  RESPONSES_REQUEST_SCHEMA,
  RESPONSES_RESPONSE_SCHEMA
};

export default SchemaValidator;
