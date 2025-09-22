// Test helper utilities
export const mockProviderConfig = {
  id: 'test-provider',
  name: 'Test Provider',
  type: 'openai',
  endpoint: 'https://api.test.com/v1',
  models: {
    'test-model': {
      id: 'test-model',
      name: 'Test Model'
    }
  },
  auth: {
    type: 'api-key',
    keys: ['test-key']
  }
};

export const mockOpenAIRequest = {
  model: 'gpt-3.5-turbo',
  messages: [
    { role: 'user', content: 'Hello' }
  ],
  temperature: 0.7,
  max_tokens: 100
};

export const mockOpenAIResponse = {
  id: 'test-id',
  object: 'chat.completion',
  created: Date.now(),
  model: 'gpt-3.5-turbo',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'Hello! How can I help you?'
      },
      finish_reason: 'stop'
    }
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 10,
    total_tokens: 20
  }
};

export const createMockResponse = (status: number, data: any) => {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data)
  };
};