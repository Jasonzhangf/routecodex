/**
 * JSON Schema definitions for OpenAI and Anthropic protocols
 * Based on real codex sample data analysis
 */

import type { JsonSchema } from '../types/index.js';

// Common reusable definitions that can be referenced across schemas
export const commonDefinitions = {
  toolCall: {
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
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  },

  functionChoice: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' }
    },
    additionalProperties: false
  }
};

/**
 * OpenAI ChatCompletion Request Schema
 * Based on real codex sample data patterns
 */
export const openAIChatRequestSchema: JsonSchema = {
  type: 'object',
  required: ['messages'],
  properties: {
    model: { type: 'string' },
    messages: {
      type: 'array',
      items: { $ref: '#/$defs/openAIMessage' }
    },
    temperature: {
      type: 'number',
      minimum: 0,
      maximum: 2,
      default: 1
    },
    max_tokens: {
      type: 'integer',
      minimum: 1
    },
    tools: {
      type: 'array',
      items: { $ref: '#/$defs/openAITool' }
    },
    tool_choice: {
      oneOf: [
        {
          type: 'string',
          enum: ['none', 'auto', 'required'],
          default: 'auto'
        },
        {
          type: 'object',
          properties: {
            type: { const: 'function' },
            function: { $ref: '#/$defs/functionChoice' }
          },
          required: ['type', 'function']
        }
      ]
    },
    stream: {
      type: 'boolean',
      default: false
    },
    top_p: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      default: 1
    },
    frequency_penalty: {
      type: 'number',
      minimum: -2,
      maximum: 2,
      default: 0
    },
    presence_penalty: {
      type: 'number',
      minimum: -2,
      maximum: 2,
      default: 0
    }
  },
  additionalProperties: true, // Allow additional properties seen in real data
  $defs: {
    openAIMessage: {
      type: 'object',
      required: ['role', 'content'],
      properties: {
        role: {
          type: 'string',
          enum: ['system', 'user', 'assistant', 'tool']
        },
        content: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: {
                type: 'object',
                required: ['type'],
                oneOf: [
                  {
                    properties: {
                      type: { const: 'text' },
                      text: { type: 'string' },
                      cache_control: {
                        type: 'object',
                        properties: {
                          type: { type: 'string' }
                        }
                      }
                    },
                    required: ['type', 'text']
                  },
                  {
                    properties: {
                      type: { const: 'image_url' },
                      image_url: {
                        type: 'object',
                        required: ['url'],
                        properties: {
                          url: { type: 'string' },
                          detail: { type: 'string', enum: ['auto', 'low', 'high'] }
                        }
                      }
                    },
                    required: ['type', 'image_url']
                  }
                ]
              }
            }
          ]
        },
        tool_calls: {
          type: 'array',
          items: commonDefinitions.toolCall
        },
        tool_call_id: { type: 'string' },
        name: { type: 'string' }
      },
      additionalProperties: true // Allow additional properties seen in real data
    },
    openAITool: {
      type: 'object',
      required: ['type', 'function'],
      properties: {
        type: { const: 'function' },
        function: {
          type: 'object',
          required: ['name', 'parameters'],
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            parameters: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                properties: { type: 'object' },
                required: { type: 'array' },
                additionalProperties: { type: 'boolean', default: false }
              },
              additionalProperties: true
            }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    toolCall: commonDefinitions.toolCall,
    functionChoice: commonDefinitions.functionChoice
  }
};

/**
 * OpenAI ChatCompletion Response Schema
 * Based on real codex sample data patterns
 */
export const openAIChatResponseSchema: JsonSchema = {
  type: 'object',
  required: ['choices'],
  properties: {
    id: { type: 'string' },
    object: { type: 'string', const: 'chat.completion' },
    created: { type: 'integer' },
    model: { type: 'string' },
    choices: {
      type: 'array',
      items: { $ref: '#/$defs/choice' }
    },
    usage: {
      type: 'object',
      properties: {
        prompt_tokens: { type: 'integer' },
        completion_tokens: { type: 'integer' },
        total_tokens: { type: 'integer' }
      }
    }
  },
  additionalProperties: true, // Allow additional properties seen in real data
  $defs: {
    choice: {
      type: 'object',
      required: ['index', 'message'],
      properties: {
        index: { type: 'integer' },
        message: { $ref: '#/$defs/responseMessage' },
        finish_reason: {
          type: 'string',
          enum: ['stop', 'length', 'tool_calls', 'content_filter', 'function_call']
        },
        logprobs: { type: 'object' },
        finish_details: { type: 'object' }
      },
      additionalProperties: true // Allow additional properties seen in real data
    },
    responseMessage: {
      type: 'object',
      required: ['role'],
      properties: {
        role: { type: 'string', const: 'assistant' },
        content: { type: 'string' },
        tool_calls: {
          type: 'array',
          items: commonDefinitions.toolCall
        },
        function_call: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            arguments: { type: 'string' }
          }
        }
      },
      additionalProperties: true // Allow additional properties seen in real data
    },
    toolCall: commonDefinitions.toolCall
  }
};

/**
 * Anthropic Messages API Request Schema
 * Based on real codex sample data patterns
 */
export const anthropicMessageRequestSchema: JsonSchema = {
  type: 'object',
  required: ['messages', 'model', 'max_tokens'],
  properties: {
    model: { type: 'string' },
    messages: {
      type: 'array',
      items: { $ref: '#/$defs/anthropicMessage' }
    },
    system: {
      oneOf: [
        { type: 'string' },
        {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              text: { type: 'string' }
            }
          }
        }
      ]
    },
    max_tokens: {
      type: 'integer',
      minimum: 1
    },
    temperature: {
      type: 'number',
      minimum: 0,
      maximum: 1
    },
    tools: {
      type: 'array',
      items: { $ref: '#/$defs/anthropicTool' }
    },
    tool_choice: {
      oneOf: [
        {
          type: 'string',
          enum: ['auto', 'any', 'none'],
          default: 'auto'
        },
        {
          type: 'object',
          properties: {
            type: { const: 'tool' },
            name: { type: 'string' }
          },
          required: ['type', 'name']
        }
      ]
    },
    stream: {
      type: 'boolean',
      default: false
    },
    top_p: {
      type: 'number',
      minimum: 0,
      maximum: 1
    },
    top_k: {
      type: 'integer',
      minimum: 0
    },
    stop_sequences: {
      type: 'array',
      items: { type: 'string' }
    }
  },
  additionalProperties: true, // Allow additional properties seen in real data
  $defs: {
    anthropicMessage: {
      type: 'object',
      required: ['role', 'content'],
      properties: {
        role: {
          type: 'string',
          enum: ['user', 'assistant']
        },
        content: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: {
                type: 'object',
                required: ['type'],
                oneOf: [
                  {
                    properties: {
                      type: { const: 'text' },
                      text: { type: 'string' }
                    },
                    required: ['type', 'text']
                  },
                  {
                    properties: {
                      type: { const: 'tool_use' },
                      id: { type: 'string' },
                      name: { type: 'string' },
                      input: { type: 'object' }
                    },
                    required: ['type', 'id', 'name', 'input']
                  },
                  {
                    properties: {
                      type: { const: 'tool_result' },
                      tool_use_id: { type: 'string' },
                      content: { type: 'string' },
                      is_error: { type: 'boolean' }
                    },
                    required: ['type', 'tool_use_id']
                  },
                  {
                    properties: {
                      type: { const: 'image' },
                      source: {
                        type: 'object',
                        required: ['type', 'media_type', 'data'],
                        properties: {
                          type: { type: 'string', enum: ['base64'] },
                          media_type: { type: 'string' },
                          data: { type: 'string' }
                        }
                      }
                    },
                    required: ['type', 'source']
                  }
                ]
              }
            }
          ]
        }
      },
      additionalProperties: true // Allow additional properties seen in real data
    },
    anthropicTool: {
      type: 'object',
      required: ['name', 'description', 'input_schema'],
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        input_schema: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            properties: { type: 'object' },
            required: { type: 'array' },
            additionalProperties: { type: 'boolean', default: false }
          },
          additionalProperties: true
        }
      },
      additionalProperties: false
    }
  }
};

/**
 * Anthropic Messages API Response Schema
 * Based on real codex sample data patterns
 */
export const anthropicMessageResponseSchema: JsonSchema = {
  type: 'object',
  required: ['id', 'type', 'role', 'content'],
  properties: {
    id: { type: 'string' },
    type: { type: 'string', const: 'message' },
    role: { type: 'string', const: 'assistant' },
    content: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type'],
        oneOf: [
          {
            properties: {
              type: { const: 'text' },
              text: { type: 'string' }
            },
            required: ['type', 'text']
          },
          {
            properties: {
              type: { const: 'tool_use' },
              id: { type: 'string' },
              name: { type: 'string' },
              input: { type: 'object' }
            },
            required: ['type', 'id', 'name', 'input']
          }
        ]
      }
    },
    model: { type: 'string' },
    stop_reason: {
      type: 'string',
      enum: ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use']
    },
    stop_sequence: { type: 'string' },
    usage: {
      type: 'object',
      properties: {
        input_tokens: { type: 'integer' },
        output_tokens: { type: 'integer' }
      }
    }
  },
  additionalProperties: true // Allow additional properties seen in real data
};

/**
 * Common tool parameter schemas
 */
export const commonToolSchemas: Record<string, JsonSchema> = {
  // Bash/Shell tool
  bash: {
    type: 'object',
    required: ['command'],
    properties: {
      command: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } }
        ]
      },
      timeout: { type: 'integer', minimum: 1 },
      description: { type: 'string' },
      run_in_background: { type: 'boolean' }
    },
    additionalProperties: true // Allow additional properties seen in real data
  },

  // Read file tool
  read: {
    type: 'object',
    required: ['file_path'],
    properties: {
      file_path: { type: 'string' },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1 }
    },
    additionalProperties: true // Allow additional properties seen in real data
  },

  // Write file tool
  write: {
    type: 'object',
    required: ['file_path', 'content'],
    properties: {
      file_path: { type: 'string' },
      content: { type: 'string' }
    },
    additionalProperties: true // Allow additional properties seen in real data
  },

  // Edit file tool
  edit: {
    type: 'object',
    required: ['file_path', 'old_string', 'new_string'],
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' }
    },
    additionalProperties: true // Allow additional properties seen in real data
  },

  // Glob/search tool
  glob: {
    type: 'object',
    required: ['pattern'],
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' }
    },
    additionalProperties: true // Allow additional properties seen in real data
  },

  // Search tool
  search: {
    type: 'object',
    required: ['pattern'],
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      glob: { type: 'string' },
      output_mode: { type: 'string' },
      '-A': { type: 'integer' },
      '-B': { type: 'integer' },
      '-C': { type: 'integer' },
      '-n': { type: 'boolean' },
      '-i': { type: 'boolean' },
      type: { type: 'string' },
      multiline: { type: 'boolean' },
      head_limit: { type: 'integer' }
    },
    additionalProperties: true // Allow additional properties seen in real data
  },

  // Sequential thinking tool
  'sequential-thinking': {
    type: 'object',
    required: ['thought', 'nextThoughtNeeded', 'thoughtNumber', 'totalThoughts'],
    properties: {
      thought: { type: 'string' },
      nextThoughtNeeded: { type: 'boolean' },
      thoughtNumber: { type: 'integer', minimum: 1 },
      totalThoughts: { type: 'integer', minimum: 1 },
      isRevision: { type: 'boolean' },
      revisesThought: { type: 'integer', minimum: 1 },
      branchFromThought: { type: 'integer', minimum: 1 },
      branchId: { type: 'string' },
      needsMoreThoughts: { type: 'boolean' }
    },
    additionalProperties: true // Allow additional properties seen in real data
  },

  // Task tool
  task: {
    type: 'object',
    required: ['description', 'prompt', 'subagent_type'],
    properties: {
      description: { type: 'string' },
      prompt: { type: 'string' },
      subagent_type: { type: 'string' }
    },
    additionalProperties: true // Allow additional properties seen in real data
  },

  // WebFetch tool
  webfetch: {
    type: 'object',
    required: ['url', 'prompt'],
    properties: {
      url: { type: 'string' },
      prompt: { type: 'string' }
    },
    additionalProperties: true // Allow additional properties seen in real data
  }
};