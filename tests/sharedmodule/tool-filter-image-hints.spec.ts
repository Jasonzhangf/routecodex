import { describe, it, expect } from '@jest/globals';
import { runChatRequestToolFilters } from '../../sharedmodule/llmswitch-core/src/conversion/shared/tool-filter-pipeline.js';

const buildTools = () => ([
  {
    type: 'function',
    function: {
      name: 'shell',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'array', items: { type: 'string' } }
        },
        required: ['command'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'view_image',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        },
        required: ['path'],
        additionalProperties: false
      }
    }
  }
]);

describe('tool filters keep view_image exposed', () => {
  it('keeps view_image when last user message has no image hint, even if earlier messages mention images', async () => {
    const req = {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: 'previous: screenshot saved as foo.png' },
        { role: 'user', content: 'now just read this markdown file please' }
      ],
      tools: buildTools()
    };

    const filtered = await runChatRequestToolFilters(req, {
      entryEndpoint: '/v1/chat/completions',
      profile: 'openai-chat'
    });

    const tools = Array.isArray((filtered as any).tools) ? (filtered as any).tools : [];
    const names = tools.map((t: any) => t?.function?.name).filter(Boolean);
    expect(names).toContain('shell');
    expect(names).toContain('view_image');
  });

  it('keeps view_image when last user message contains an image-like path', async () => {
    const req = {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: '请帮我查看 ./assets/logo.png 这张图片' }
      ],
      tools: buildTools()
    };

    const filtered = await runChatRequestToolFilters(req, {
      entryEndpoint: '/v1/chat/completions',
      profile: 'openai-chat'
    });

    const tools = Array.isArray((filtered as any).tools) ? (filtered as any).tools : [];
    const names = tools.map((t: any) => t?.function?.name).filter(Boolean);
    expect(names).toContain('view_image');
  });

  it('keeps view_image when last user message contains an image content part', async () => {
    const req = {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '请分析下面的图片' },
            { type: 'image_url', image_url: { url: 'https://example.com/foo.png' } }
          ]
        }
      ],
      tools: buildTools()
    };

    const filtered = await runChatRequestToolFilters(req, {
      entryEndpoint: '/v1/chat/completions',
      profile: 'openai-chat'
    });

    const tools = Array.isArray((filtered as any).tools) ? (filtered as any).tools : [];
    const names = tools.map((t: any) => t?.function?.name).filter(Boolean);
    expect(names).toContain('view_image');
  });
});
