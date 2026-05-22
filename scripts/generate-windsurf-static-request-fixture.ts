import fs from 'node:fs/promises';
import path from 'node:path';

import { WindsurfStaticRequestHarness } from '../src/debug/harnesses/windsurf-static-request-harness.ts';

const OUT_DIR = path.join(process.cwd(), 'tests/fixtures/windsurf-static-request-harness');

const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

async function main() {
  const harness = new WindsurfStaticRequestHarness(deps);
  const result = await harness.executeForward({
    runtime: {
      runtimeKey: 'windsurf-static-fixture-baseline',
      providerId: 'windsurf',
      providerKey: 'windsurf',
      providerType: 'openai',
      providerProtocol: 'openai',
      providerModule: 'windsurf-chat-provider',
      endpoint: '',
      defaultModel: 'gpt-5.4-medium',
      auth: {
        type: 'apikey',
        value: 'devin-session-token$fixture-baseline',
      },
    } as any,
    metadata: {
      requestId: 'rid-windsurf-static-fixture-baseline',
      providerId: 'windsurf',
      providerKey: 'windsurf',
      providerType: 'openai',
      providerProtocol: 'openai',
      routeName: 'default',
      target: { providerKey: 'windsurf' },
    } as any,
    request: {
      body: {
        model: 'gpt-5.4-medium',
        apiKey: 'devin-session-token$fixture-baseline',
        messages: [
          { role: 'user', content: 'inspect repo' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                function: {
                  name: 'shell_command',
                  arguments: '{"command":"pwd"}',
                },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '/tmp/project', name: 'shell_command' },
          { role: 'user', content: 'continue' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'shell_command',
              description: 'run shell',
              parameters: { type: 'object', properties: { command: { type: 'string' } } },
            },
          },
          {
            type: 'function',
            function: {
              name: 'apply_patch',
              description: 'patch files',
              parameters: { type: 'object', properties: { patch: { type: 'string' } } },
            },
          },
        ],
        tool_choice: {
          type: 'function',
          function: { name: 'shell_command' },
        },
      },
    },
  });

  const fixture = {
    semanticConversation: result.semanticConversation,
    lens: result.lens,
    outboundShape: {
      topLevelKeys: Object.keys(result.outboundRequest).sort(),
      metadataKeys: Object.keys((result.outboundRequest as any).metadata || {}).sort(),
      completionsRequestKeys: Object.keys((result.outboundRequest as any).completionsRequest || {}).sort(),
      configurationKeys: Object.keys(((result.outboundRequest as any).completionsRequest || {}).configuration || {}).sort(),
      promptRowKeyMatrix: Array.isArray((result.outboundRequest as any).chatMessagePrompts)
        ? (result.outboundRequest as any).chatMessagePrompts.map((row: Record<string, unknown>) => Object.keys(row || {}).sort())
        : [],
    },
  };

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, 'baseline.json'),
    `${JSON.stringify(fixture, null, 2)}\n`,
    'utf8',
  );
  console.log(`wrote ${path.join(OUT_DIR, 'baseline.json')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
