import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from '@jest/globals';

const ROOT = process.cwd();
const REQUEST_EXECUTOR_PATH = path.join(ROOT, 'src/server/runtime/http-server/request-executor.ts');
const RESPONSES_HANDLER_PATH = path.join(ROOT, 'src/server/handlers/responses-handler.ts');
let MetadataCenter: any;
let writeProviderProtocolRuntimeControl: any;
let resolveResponsesConversationRequestCaptureArgsForChatProcessEntry: any;

beforeAll(async () => {
  ({ MetadataCenter } = await import(
    '../../../../src/server/runtime/http-server/metadata-center/metadata-center.ts'
  ));
  ({
    writeProviderProtocolRuntimeControl,
    resolveResponsesConversationRequestCaptureArgsForChatProcessEntry
  } = await import('../../../../src/server/runtime/http-server/request-executor.ts'));
});

describe('request-executor metadata center contract', () => {
  it('reuses mergedMetadata instead of cloning when building conversionPipelineMetadata', () => {
    const source = fs.readFileSync(REQUEST_EXECUTOR_PATH, 'utf8');

    expect(source).not.toContain('function cloneMetadataPreservingBoundCenter(');
    expect(source).toContain('mergedMetadata.routeName = pipelineRouteName;');
    expect(source).toContain('mergedMetadata.responseSemantics = responseSemantics;');
    expect(source).toContain('const conversionPipelineMetadata = mergedMetadata;');
  });

  it('writes providerProtocol into the bound MetadataCenter runtime control', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);

    writeProviderProtocolRuntimeControl(metadata, 'openai-responses');

    expect(center.readRuntimeControl().providerProtocol).toBe('openai-responses');
    expect(metadata.providerProtocol).toBeUndefined();
  });

  it('allows the request-route owner to replace providerProtocol across provider reroute attempts', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);

    writeProviderProtocolRuntimeControl(metadata, 'openai-chat');
    writeProviderProtocolRuntimeControl(metadata, 'anthropic-messages');

    expect(center.readRuntimeControl().providerProtocol).toBe('anthropic-messages');
    expect(metadata.providerProtocol).toBeUndefined();
  });

  it('fails fast when a non-owner prewrites conflicting providerProtocol', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    center.writeRuntimeControl(
      'providerProtocol',
      'openai-chat',
      {
        module: 'test',
        symbol: 'fails fast when a non-owner prewrites conflicting providerProtocol',
        stage: 'test'
      },
      'seed conflicting provider protocol'
    );

    expect(() => writeProviderProtocolRuntimeControl(metadata, 'anthropic-messages')).toThrow(
      'MetadataCenter runtime_control.providerProtocol conflict: existing=openai-chat selected=anthropic-messages'
    );
  });

  it('captures Responses request context from Chat Process snapshot instead of handler-owned capture', () => {
    const metadata: Record<string, unknown> = {
      routecodexRoutingPolicyGroup: 'gateway_priority_5555',
      entryPort: 5555,
      contextSnapshot: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        toolsRaw: [{ type: 'function', name: 'exec_command' }]
      }
    };
    const center = MetadataCenter.attach(metadata);
    center.writeRequestTruth(
      'requestId',
      'req_chatprocess_capture_1',
      {
        module: 'test',
        symbol: 'captures Responses request context from Chat Process snapshot instead of handler-owned capture',
        stage: 'test'
      },
      'test request id'
    );
    center.writeRequestTruth(
      'sessionId',
      'sess_chatprocess_capture_1',
      {
        module: 'test',
        symbol: 'captures Responses request context from Chat Process snapshot instead of handler-owned capture',
        stage: 'test'
      },
      'test session id'
    );
    center.writeRequestTruth(
      'conversationId',
      'conv_chatprocess_capture_1',
      {
        module: 'test',
        symbol: 'captures Responses request context from Chat Process snapshot instead of handler-owned capture',
        stage: 'test'
      },
      'test conversation id'
    );

    const args = resolveResponsesConversationRequestCaptureArgsForChatProcessEntry({
      input: {
        entryEndpoint: '/v1/responses',
        requestId: 'req_chatprocess_capture_1',
        body: {
          model: 'gpt-5.5',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
        }
      },
      metadata,
      providerKey: 'provider.key.model'
    });

    expect(args).toMatchObject({
      requestId: 'req_chatprocess_capture_1',
      payload: expect.objectContaining({ model: 'gpt-5.5' }),
      context: metadata.contextSnapshot,
      sessionId: 'sess_chatprocess_capture_1',
      conversationId: 'conv_chatprocess_capture_1',
      providerKey: 'provider.key.model',
      entryKind: 'responses',
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555'
    });

    const executorSource = fs.readFileSync(REQUEST_EXECUTOR_PATH, 'utf8');
    expect(executorSource).toContain('captureResponsesConversationRequestContextAtChatProcessEntry');
    expect(executorSource).toContain('await captureResponsesRequestContextForRequest(captureArgs);');
    const handlerSource = fs.readFileSync(RESPONSES_HANDLER_PATH, 'utf8');
    expect(handlerSource).not.toContain(['captureResponsesPipeline', 'RequestContextForHttp'].join(''));
  });

  it('captures Responses request context from original request payload when no debug context snapshot exists', () => {
    const metadata: Record<string, unknown> = {
      routecodexRoutingPolicyGroup: 'gateway_priority_5555',
      entryPort: 5555
    };
    const center = MetadataCenter.attach(metadata);
    center.writeRequestTruth(
      'requestId',
      'req_payload_capture_1',
      {
        module: 'test',
        symbol: 'captures Responses request context from original request payload when no debug context snapshot exists',
        stage: 'test'
      },
      'test request id'
    );
    center.writeRequestTruth(
      'sessionId',
      'sess_payload_capture_1',
      {
        module: 'test',
        symbol: 'captures Responses request context from original request payload when no debug context snapshot exists',
        stage: 'test'
      },
      'test session id'
    );

    const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }];
    const tools = [{ type: 'function', name: 'exec_command' }];
    const args = resolveResponsesConversationRequestCaptureArgsForChatProcessEntry({
      input: {
        entryEndpoint: '/v1/responses',
        requestId: 'req_payload_capture_1',
        body: {
          model: 'gpt-5.5',
          input,
          tools
        }
      },
      metadata,
      providerKey: 'provider.key.model'
    });

    expect(args).toMatchObject({
      requestId: 'req_payload_capture_1',
      payload: expect.objectContaining({ model: 'gpt-5.5' }),
      context: {
        input,
        toolsRaw: tools
      },
      sessionId: 'sess_payload_capture_1',
      providerKey: 'provider.key.model',
      entryKind: 'responses',
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555'
    });
  });
});
