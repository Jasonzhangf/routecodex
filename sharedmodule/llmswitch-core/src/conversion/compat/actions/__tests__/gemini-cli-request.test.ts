import { wrapGeminiCliRequest } from '../gemini-cli-request.js';

describe('gemini-cli-request native wrapper', () => {
  test('wraps request payload and normalizes request node through native compat', () => {
    const result = wrapGeminiCliRequest(
      {
        model: 'gemini-2.5-pro',
        requestId: 'agent-123',
        userAgent: 'antigravity',
        metadata: { x: 1 },
        stream: true,
        sessionId: 'sess_1',
        web_search: { enabled: true },
        tools: [
          {
            functionDeclarations: [
              {
                name: 'exec_command',
                parameters: {
                  type: 'object',
                  properties: {
                    cmd: { type: 'string', description: 'cmd desc' },
                    workdir: { type: 'string' }
                  }
                }
              }
            ]
          }
        ],
        contents: [
          {
            parts: [
              {
                functionCall: {
                  name: 'exec_command',
                  args: { cmd: 'pwd' }
                }
              }
            ]
          }
        ]
      } as any,
      {
        compatibilityProfile: 'chat:gemini-cli',
        providerProtocol: 'gemini-chat',
        requestId: 'req_gemini_cli_1',
        routeId: 'coding-primary'
      } as any
    );

    expect((result as any).tools).toBeUndefined();
    expect((result as any).contents).toBeUndefined();
    expect((result as any).metadata).toBeUndefined();
    expect((result as any).request.tools[0].functionDeclarations[0].parameters.type).toBe('OBJECT');
    expect((result as any).request.contents[0].parts[0].functionCall.args.command).toBe('pwd');
    expect((result as any).request.contents[0].parts[0].functionCall.args.cmd).toBeUndefined();
  });

  test('applies Claude schema compat through native path', () => {
    const result = wrapGeminiCliRequest(
      {
        model: 'claude-3-7-sonnet',
        requestId: 'agent-claude-cli-1',
        tools: [
          {
            functionDeclarations: [
              {
                name: 'exec_command',
                strict: true,
                parameters: {
                  type: 'object',
                  properties: {
                    cmd: { type: 'string' }
                  }
                }
              }
            ]
          }
        ]
      } as any,
      {
        compatibilityProfile: 'chat:gemini-cli',
        providerProtocol: 'gemini-chat',
        requestId: 'req_gemini_cli_claude_1',
        routeId: 'coding-primary'
      } as any
    );

    expect((result as any).model).toBe('claude-3-7-sonnet');
    expect((result as any).request.tools[0].functionDeclarations[0].parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: true
    });
    expect((result as any).request.tools[0].functionDeclarations[0].strict).toBeUndefined();
  });

  test('keeps only allowed top-level fields after native wrap', () => {
    const result = wrapGeminiCliRequest(
      {
        model: 'gemini-2.5-pro',
        requestId: 'agent-gemini-cli-pick-1',
        userAgent: 'antigravity',
        action: 'run',
        requestType: 'chat',
        project: 'demo',
        unknownTopLevel: { k: 'v' },
        metadata: { x: 1 },
        tools: [
          {
            functionDeclarations: [{ name: 'exec_command', parameters: { type: 'object', properties: {} } }]
          }
        ]
      } as any,
      {
        compatibilityProfile: 'chat:gemini-cli',
        providerProtocol: 'gemini-chat',
        requestId: 'req_gemini_cli_pick_1',
        routeId: 'coding-primary'
      } as any
    );

    expect((result as any).unknownTopLevel).toBeUndefined();
    expect((result as any).metadata).toBeUndefined();
    expect((result as any).model).toBe('gemini-2.5-pro');
    expect((result as any).requestId).toBe('agent-gemini-cli-pick-1');
    expect((result as any).userAgent).toBe('antigravity');
    expect((result as any).action).toBe('run');
    expect((result as any).requestType).toBe('chat');
    expect((result as any).project).toBe('demo');
    expect((result as any).request).toBeDefined();
  });
});
