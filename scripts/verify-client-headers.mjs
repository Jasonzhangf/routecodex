#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadModule(relPath) {
  const modulePath = pathToFileURL(path.join(ROOT, relPath)).href;
  return import(modulePath);
}

class RecordingHttpClient {
  constructor() {
    this.lastHeaders = undefined;
  }

  async post(endpoint, _data, headers) {
    this.lastHeaders = headers ? { ...headers } : {};
    return {
      data: { ok: true },
      status: 200,
      statusText: 'OK',
      headers: {},
      url: endpoint
    };
  }

  async postStream() {
    throw new Error('RecordingHttpClient.postStream not implemented');
  }

  async get(endpoint, headers) {
    return {
      data: {},
      status: 200,
      statusText: 'OK',
      headers: headers ?? {},
      url: endpoint
    };
  }
}

async function main() {
  const deps = {
    errorHandlingCenter: {
      handleError: async () => {},
      createContext: () => ({}),
      getStatistics: () => ({})
    },
    debugCenter: {
      logDebug: () => {},
      logError: () => {},
      logModule: () => {},
      processDebugEvent: () => {},
      getLogs: () => []
    },
    logger: {
      logModule: () => {},
      logError: () => {},
      logDebug: () => {},
      logPipeline: () => {},
      logRequest: () => {},
      logResponse: () => {},
      logTransformation: () => {},
      logProviderRequest: () => {},
      getRequestLogs: () => ({ general: [], transformations: [], provider: [] }),
      getPipelineLogs: () => ({ general: [], transformations: [], provider: [] }),
      getRecentLogs: () => [],
      getTransformationLogs: () => [],
      getProviderLogs: () => [],
      getStatistics: () => ({
        totalLogs: 0,
        logsByLevel: {},
        logsByCategory: {},
        logsByPipeline: {},
        transformationCount: 0,
        providerRequestCount: 0
      }),
      clearLogs: () => {},
      exportLogs: () => [],
      log: () => {}
    }
  };

  const { HttpTransportProvider } = await loadModule('dist/providers/core/runtime/http-transport-provider.js');
  const { attachProviderRuntimeMetadata } = await loadModule('dist/providers/core/runtime/provider-runtime-metadata.js');

  class TestProvider extends HttpTransportProvider {
    createHttpClient() {
      this.client = new RecordingHttpClient();
      this.httpClient = this.client;
    }

    wantsUpstreamSse() {
      return false;
    }
  }

  const providerConfig = {
    id: 'verify-http-provider',
    type: 'responses-http-provider',
    config: {
      providerType: 'responses',
      providerId: 'crs.key1',
      auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
      overrides: {
        baseUrl: 'https://example.invalid',
        endpoint: '/responses',
        defaultModel: 'gpt-5.1-codex'
      }
    }
  };

  const provider = new TestProvider(providerConfig, deps);
  await provider.initialize();

  const inboundHeaders = {
    accept: 'text/event-stream',
    conversation_id: 'verify-conv',
    session_id: 'verify-sess'
  };

  const providerRequest = {
    metadata: {
      clientHeaders: inboundHeaders,
      stream: true
    },
    data: {
      model: 'gpt-5.1-codex',
      input: []
    }
  };

  attachProviderRuntimeMetadata(providerRequest, {
    requestId: 'verify-req',
    providerId: 'crs.key1',
    providerKey: 'crs.key1.gpt-5.1-codex',
    providerType: 'responses',
    providerProtocol: 'openai-responses',
    routeName: 'verify',
    metadata: {
      entryEndpoint: '/v1/responses',
      clientHeaders: inboundHeaders
    },
    target: {
      providerKey: 'crs.key1.gpt-5.1-codex',
      providerType: 'responses',
      compatibilityProfile: undefined,
      runtimeKey: 'crs.key1',
      modelId: 'gpt-5.1-codex'
    }
  });

  const response = await provider.processIncoming(providerRequest);
  if (!response) {
    throw new Error('provider did not return a response during verification');
  }

  const headers = provider.client.lastHeaders || {};
  if (headers['conversation_id'] !== 'verify-conv' || headers['session_id'] !== 'verify-sess') {
    throw new Error(
      `client headers not forwarded. observed=${JSON.stringify(headers)} expected conversation_id/session_id`
    );
  }

  console.log('[verify-client-headers] ✅ inbound conversation/session headers forwarded');
}

main().catch((error) => {
  console.error('[verify-client-headers] ❌ failed:', error?.message || error);
  process.exit(1);
});
