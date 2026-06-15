import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('server responses SSE surface single owner', () => {
  it('keeps handler-response-sse split between SSE facade and lifecycle facade', () => {
    const source = readFileSync(join(root, 'src/server/handlers/handler-response-sse.ts'), 'utf8');
    const importStatements = source
      .split('\n')
      .filter((line) => line.startsWith('import ') || line.startsWith('} from '));
    const joinedImports = importStatements.join('\n');

    expect(source).toContain("from '../../modules/llmswitch/bridge/responses-sse-bridge.js'");
    expect(source).toContain("from '../../modules/llmswitch/bridge/responses-response-bridge.js'");
    expect(joinedImports).not.toMatch(/buildResponsesSseErrorPayloadForHttp[\s\S]*responses-response-bridge\.js/);
    expect(joinedImports).not.toMatch(/shouldDispatchResponsesSseToClientForHttp[\s\S]*responses-response-bridge\.js/);
  });

  it('keeps handler-response-utils split between SSE facade and lifecycle facade', () => {
    const source = readFileSync(join(root, 'src/server/handlers/handler-response-utils.ts'), 'utf8');

    expect(source).toContain("from '../../modules/llmswitch/bridge/responses-sse-bridge.js'");
    expect(source).toContain("from '../../modules/llmswitch/bridge/responses-response-bridge.js'");
  });

  it('does not re-export SSE bridge symbols from the lifecycle bridge index section', () => {
    const source = readFileSync(join(root, 'src/modules/llmswitch/bridge/index.ts'), 'utf8');
    const lifecycleSection = source.split("} from './responses-response-bridge.js';")[0]?.split("export {\n  resolveResponsesConversationClearReasonForHttp")[1] ?? '';

    expect(source).toContain("from './responses-sse-bridge.js'");
    expect(lifecycleSection).not.toContain('buildResponsesSseErrorPayloadForHttp');
    expect(lifecycleSection).not.toContain('shouldDispatchResponsesSseToClientForHttp');
  });
});
