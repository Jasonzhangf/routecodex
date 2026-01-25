import { describe, it, expect } from '@jest/globals';
import { runChatRequestToolFilters } from '../../sharedmodule/llmswitch-core/src/conversion/shared/tool-filter-pipeline.js';

function findTool(tools: any[], name: string): any | null {
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const n = t?.function?.name;
    if (typeof n === 'string' && n === name) return t;
  }
  return null;
}

describe('MCP tool descriptions (avoid server-name guessing)', () => {
  const prevExpose = process.env.RCC_MCP_EXPOSE;
  const prevServers = process.env.RCC_MCP_SERVERS;

  afterEach(() => {
    process.env.RCC_MCP_EXPOSE = prevExpose;
    process.env.RCC_MCP_SERVERS = prevServers;
  });

  it('fills empty list_mcp_resources description with server-label reminder', async () => {
    process.env.RCC_MCP_EXPOSE = 'phase';
    process.env.RCC_MCP_SERVERS = '';

    const req = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'list_mcp_resources',
            description: '',
            parameters: { type: 'object', properties: {}, additionalProperties: true }
          }
        }
      ]
    };

    const filtered = await runChatRequestToolFilters(req as any, {
      entryEndpoint: '/v1/chat/completions',
      profile: 'openai-chat'
    } as any);

    const tools = Array.isArray((filtered as any).tools) ? ((filtered as any).tools as any[]) : [];
    const listTool = findTool(tools, 'list_mcp_resources');
    expect(listTool).toBeTruthy();
    const desc = String(listTool?.function?.description || '');
    expect(desc.trim().length).toBeGreaterThan(0);
    expect(desc).toContain('If you do not know the MCP server name yet');
    expect(desc).toContain('arguments.server is an MCP server label');
  });

  it('uses RCC_MCP_SERVERS to expose known server enum and mention them in description', async () => {
    process.env.RCC_MCP_EXPOSE = 'phase';
    process.env.RCC_MCP_SERVERS = 'context7,playwright,mcp-server-time';

    const req = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'list_mcp_resources',
            description: '',
            parameters: { type: 'object', properties: {}, additionalProperties: true }
          }
        }
      ]
    };

    const filtered = await runChatRequestToolFilters(req as any, {
      entryEndpoint: '/v1/chat/completions',
      profile: 'openai-chat'
    } as any);

    const tools = Array.isArray((filtered as any).tools) ? ((filtered as any).tools as any[]) : [];
    const listTool = findTool(tools, 'list_mcp_resources');
    expect(listTool).toBeTruthy();
    const serverSchema = listTool?.function?.parameters?.properties?.server;
    expect(serverSchema?.type).toBe('string');
    expect(serverSchema?.enum).toEqual(['context7', 'playwright', 'mcp-server-time']);

    const desc = String(listTool?.function?.description || '');
    expect(desc).toContain('Known MCP servers: context7, playwright, mcp-server-time.');
  });

  it('does not treat assistant tool_calls.server guesses as known servers', async () => {
    process.env.RCC_MCP_EXPOSE = 'phase';
    process.env.RCC_MCP_SERVERS = '';

    const req = {
      model: 'gpt-test',
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'list_mcp_resources',
                arguments: JSON.stringify({ server: 'shell' })
              }
            }
          ]
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'list_mcp_resources',
            description: '',
            parameters: { type: 'object', properties: {}, additionalProperties: true }
          }
        }
      ]
    };

    const filtered = await runChatRequestToolFilters(req as any, {
      entryEndpoint: '/v1/chat/completions',
      profile: 'openai-chat'
    } as any);

    const tools = Array.isArray((filtered as any).tools) ? ((filtered as any).tools as any[]) : [];
    const listTool = findTool(tools, 'list_mcp_resources');
    expect(listTool).toBeTruthy();
    const serverSchema = listTool?.function?.parameters?.properties?.server;
    expect(serverSchema?.type).toBe('string');
    expect(serverSchema?.enum).toBeUndefined();
  });

  it('extracts known servers from list_mcp_resources tool results (rcc.tool.v1)', async () => {
    process.env.RCC_MCP_EXPOSE = 'phase';
    process.env.RCC_MCP_SERVERS = '';

    const req = {
      model: 'gpt-test',
      messages: [
        {
          role: 'tool',
          content: JSON.stringify({
            version: 'rcc.tool.v1',
            tool: { name: 'list_mcp_resources' },
            result: { output: { servers: ['context7', 'playwright'] } }
          })
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'list_mcp_resources',
            description: '',
            parameters: { type: 'object', properties: {}, additionalProperties: true }
          }
        }
      ]
    };

    const filtered = await runChatRequestToolFilters(req as any, {
      entryEndpoint: '/v1/chat/completions',
      profile: 'openai-chat'
    } as any);

    const tools = Array.isArray((filtered as any).tools) ? ((filtered as any).tools as any[]) : [];
    const listTool = findTool(tools, 'list_mcp_resources');
    expect(listTool).toBeTruthy();
    const serverSchema = listTool?.function?.parameters?.properties?.server;
    expect(serverSchema?.type).toBe('string');
    expect(serverSchema?.enum).toEqual(['context7', 'playwright']);

    const desc = String(listTool?.function?.description || '');
    expect(desc).toContain('Known MCP servers: context7, playwright.');
  });

  it('does not inject MCP tools when absent', async () => {
    process.env.RCC_MCP_EXPOSE = 'phase';
    process.env.RCC_MCP_SERVERS = 'context7,playwright';

    const req = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }]
    };

    const filtered = await runChatRequestToolFilters(req as any, {
      entryEndpoint: '/v1/chat/completions',
      profile: 'openai-chat'
    } as any);

    expect((filtered as any).tools).toBeUndefined();
  });

  it('keeps MCP tool lists stable after empty list_mcp_resources output (non-wrapped tool output)', async () => {
    process.env.RCC_MCP_EXPOSE = 'phase';
    process.env.RCC_MCP_SERVERS = '';

    const req = {
      model: 'gpt-test',
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'list_mcp_resources',
                arguments: JSON.stringify({})
              }
            }
          ]
        },
        {
          role: 'tool',
          content: JSON.stringify({ resources: [] })
        }
      ],
      tools: [
        { type: 'function', function: { name: 'list_mcp_resources', description: '', parameters: { type: 'object', properties: {}, additionalProperties: true } } },
        { type: 'function', function: { name: 'list_mcp_resource_templates', description: '', parameters: { type: 'object', properties: {}, additionalProperties: true } } },
        { type: 'function', function: { name: 'read_mcp_resource', description: '', parameters: { type: 'object', properties: {}, additionalProperties: true } } }
      ]
    };

    const filtered = await runChatRequestToolFilters(req as any, {
      entryEndpoint: '/v1/chat/completions',
      profile: 'openai-chat'
    } as any);

    const tools = Array.isArray((filtered as any).tools) ? ((filtered as any).tools as any[]) : [];
    expect(findTool(tools, 'list_mcp_resources')).toBeTruthy();
    expect(findTool(tools, 'list_mcp_resource_templates')).toBeTruthy();
    expect(findTool(tools, 'read_mcp_resource')).toBeTruthy();
  });
});
