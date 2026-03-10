#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const { RequestToolListFilter } = await import('../../dist/filters/special/request-tool-list-filter.js');

  const filter = new RequestToolListFilter();
  const ctx = { stage: 'request_pre' };

  // 1) off mode: do not force tools onto requests without tools
  {
    process.env.RCC_MCP_EXPOSE = 'off';
    delete process.env.RCC_MCP_SERVERS;
    const res = filter.apply({ model: 'gpt-5.2', messages: [] }, ctx);
    assert.equal(res.ok, true);
    assert.ok(!('tools' in res.data) || (Array.isArray(res.data.tools) && res.data.tools.length === 0));
  }

  // 2) phase mode: ensure list tools; do not expose read tool without known servers
  {
    process.env.RCC_MCP_EXPOSE = 'phase';
    delete process.env.RCC_MCP_SERVERS;
    const res = filter.apply({ model: 'gpt-5.2', messages: [], tools: [] }, ctx);
    const names = new Set((res.data.tools || []).map((t) => t?.function?.name).filter(Boolean));
    assert.ok(names.has('list_mcp_resources'));
    assert.ok(names.has('list_mcp_resource_templates'));
    assert.ok(!names.has('read_mcp_resource'), 'read tool must be gated until servers are known');
  }

  // 3) phase mode: server labels discovered from tool results → expose read tool with enum
  {
    process.env.RCC_MCP_EXPOSE = 'phase';
    delete process.env.RCC_MCP_SERVERS;
    const toolEnvelope = JSON.stringify({
      version: 'rcc.tool.v1',
      tool: { name: 'list_mcp_resources' },
      result: { output: { servers: ['context7'] } }
    });
    const res = filter.apply(
      {
        model: 'gpt-5.2',
        messages: [{ role: 'tool', content: toolEnvelope }],
        tools: []
      },
      ctx
    );
    const names = new Set((res.data.tools || []).map((t) => t?.function?.name).filter(Boolean));
    assert.ok(names.has('read_mcp_resource'), 'read tool must be exposed once servers are known');
    const read = (res.data.tools || []).find((t) => t?.function?.name === 'read_mcp_resource');
    assert.deepEqual(read.function.parameters.properties.server.enum, ['context7']);
  }

  // 4) empty/unsupported MCP list detected → remove MCP resource tools to avoid loops
  {
    process.env.RCC_MCP_EXPOSE = 'all';
    process.env.RCC_MCP_SERVERS = 'context7';
    const toolErr = JSON.stringify({
      version: 'rcc.tool.v1',
      tool: { name: 'list_mcp_resources' },
      result: { output: { resources: [] } }
    });
    const res = filter.apply(
      {
        model: 'gpt-5.2',
        messages: [{ role: 'tool', content: toolErr }],
        tools: [
          { type: 'function', function: { name: 'list_mcp_resources', description: 'x', parameters: {} } },
          { type: 'function', function: { name: 'read_mcp_resource', description: 'x', parameters: {} } }
        ]
      },
      ctx
    );
    const names = new Set((res.data.tools || []).map((t) => t?.function?.name).filter(Boolean));
    assert.ok(!names.has('list_mcp_resources'));
    assert.ok(!names.has('read_mcp_resource'));
  }

  console.log('✅ coverage-request-tool-list-filter passed');
}

main().catch((e) => {
  console.error('❌ coverage-request-tool-list-filter failed:', e);
  process.exit(1);
});

