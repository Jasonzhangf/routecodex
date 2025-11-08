/**
 * 流水线Mock数据
 */

export const mockProviderRequests = {
  openaiChat: {
    url: 'https://api.openai.com/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer sk-test-key',
      'User-Agent': 'RouteCodex/2.0'
    },
    body: {
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant.'
        },
        {
          role: 'user', 
          content: 'Hello, how are you?'
        }
      ],
      temperature: 0.7,
      max_tokens: 1000
    }
  },

  anthropicMessages: {
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'sk-ant-test-key',
      'anthropic-version': '2023-06-01'
    },
    body: {
      model: 'claude-3-sonnet-20240229',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: 'Hello, how are you?'
        }
      ]
    }
  },

  toolCalls: {
    url: 'https://api.openai.com/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer sk-test-key',
      'User-Agent': 'RouteCodex/2.0'
    },
    body: {
      model: 'gpt-4',
      messages: [
        {
          role: 'user',
          content: 'What is the weather like?'
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get current weather information',
            parameters: {
              type: 'object',
              properties: {
                location: {
                  type: 'string',
                  description: 'City name'
                }
              },
              required: ['location']
            }
          }
        }
      ],
      tool_choice: 'auto'
    }
  }
};

export const mockProviderResponses = {
  openaiChat: {
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Hello! I am doing well, thank you for asking. How can I assist you today?'
        },
        finish_reason: 'stop'
      }
    ],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 18,
      total_tokens: 38
    },
    model: 'gpt-4',
    created: Date.now() / 1000
  },

  anthropicMessages: {
    id: 'msg_test_id',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: 'Hello! I am doing well, thank you for asking. How can I assist you today?'
      }
    ],
    model: 'claude-3-sonnet-20240229',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 20,
      output_tokens: 18
    }
  },

  toolCalls: {
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_test_id',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: JSON.stringify({ location: 'San Francisco' })
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ],
    usage: {
      prompt_tokens: 25,
      completion_tokens: 10,
      total_tokens: 35
    },
    model: 'gpt-4',
    created: Date.now() / 1000
  }
};

export const mockCompatibilityData = {
  v1CompatPre: {
    model: 'gpt-4',
    messages: [
      {
        role: 'system',
        content: 'You are a helpful assistant.'
      },
      {
        role: 'user',
        content: 'Hello, how are you?'
      }
    ],
    temperature: 0.7,
    max_tokens: 1000
  },

  v1CompatPost: {
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Hello! I am doing well, thank you for asking. How can I assist you today?'
        },
        finish_reason: 'stop'
      }
    ],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 18,
      total_tokens: 38
    }
  },

  v2WorkflowPre: {
    request: {
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant.'
        },
        {
          role: 'user',
          content: 'Hello, how are you?'
        }
      ],
      temperature: 0.7,
      max_tokens: 1000
    },
    context: {
      stage: 'workflow-pre',
      timestamp: Date.now()
    }
  },

  v2WorkflowPost: {
    response: {
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello! I am doing well, thank you for asking. How can I assist you today?'
          },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 18,
        total_tokens: 38
      }
    },
    context: {
      stage: 'workflow-post',
      timestamp: Date.now()
    }
  }
};
