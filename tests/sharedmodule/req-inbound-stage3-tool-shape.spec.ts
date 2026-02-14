import { describe, expect, it } from '@jest/globals';

import { runReqInboundStage3ContextCapture } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_inbound/req_inbound_stage3_context_capture/index.js';

describe('req_inbound stage3 tool shape repair', () => {
  it('repairs assistant shell-like tool call args before tool governance', async () => {
    const rawRequest: any = {
      tools: [{ type: 'function', function: { name: 'exec_command' } }],
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'shell_command',
                arguments: '{"cmd":"rg -n \\"AnchorVerificationBlock\\" --type ts","cwd":"/repo"}'
              }
            }
          ]
        }
      ]
    };

    await runReqInboundStage3ContextCapture({
      rawRequest,
      adapterContext: { providerProtocol: 'openai-chat' } as any
    });

    const call = rawRequest.messages[0].tool_calls[0];
    const args = JSON.parse(String(call.function.arguments || '{}'));
    expect(call.function.name).toBe('exec_command');
    expect(args.cmd).toBe('rg -n "AnchorVerificationBlock" --type ts');
    expect(args.command).toBe('rg -n "AnchorVerificationBlock" --type ts');
    expect(args.workdir).toBe('/repo');
  });

  it('injects parse-failure precheck for shell/exec missing command field', async () => {
    const rawRequest: any = {
      messages: [
        {
          role: 'tool',
          name: 'shell_command',
          tool_call_id: 'call_shell_1',
          content: 'failed to parse function arguments: missing field `command` at line 1 column 102'
        }
      ]
    };

    await runReqInboundStage3ContextCapture({
      rawRequest,
      adapterContext: { providerProtocol: 'openai-chat' } as any
    });

    const content = String(rawRequest.messages[0].content || '');
    expect(content).toContain('[RouteCodex precheck]');
    expect(content).toContain('缺少字段 "command"');
  });
});

