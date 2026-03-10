#!/usr/bin/env node
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function walkStrictSchema(node, loc) {
  if (!isRecord(node)) return;

  const hasProps = isRecord(node.properties);
  const isObj = node.type === 'object' || hasProps;
  if (isObj && hasProps) {
    assert(
      node.additionalProperties === false,
      `strict schema violation at ${loc}: additionalProperties must be false`
    );
    assert(
      Array.isArray(node.required),
      `strict schema violation at ${loc}: required must be an array`
    );
    for (const key of Object.keys(node.properties)) {
      assert(
        node.required.includes(key),
        `strict schema violation at ${loc}: required missing "${key}"`
      );
      walkStrictSchema(node.properties[key], `${loc}.properties.${key}`);
    }
  }

  if (isRecord(node.items)) {
    walkStrictSchema(node.items, `${loc}.items`);
  }
  if (Array.isArray(node.anyOf)) {
    node.anyOf.forEach((s, idx) => walkStrictSchema(s, `${loc}.anyOf[${idx}]`));
  }
  if (Array.isArray(node.oneOf)) {
    node.oneOf.forEach((s, idx) => walkStrictSchema(s, `${loc}.oneOf[${idx}]`));
  }
  if (Array.isArray(node.allOf)) {
    node.allOf.forEach((s, idx) => walkStrictSchema(s, `${loc}.allOf[${idx}]`));
  }
}

async function main() {
  const chatProcess = await import(path.join(projectRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process.js'));
  const { runHubChatProcess } = chatProcess;

  const clockConfig = { enabled: true, retentionMs: 20 * 60_000, dueWindowMs: 60_000, tickMs: 10_000 };

  const baseRequest = {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    parameters: { stream: false },
    metadata: { originalEndpoint: '/v1/responses' }
  };

  const result = await runHubChatProcess({
    request: baseRequest,
    requestId: 'req_clock_schema_strict',
    entryEndpoint: '/v1/responses',
    rawPayload: {},
    metadata: {
      providerProtocol: 'openai-responses',
      sessionId: 'sess_clock_schema_strict',
      clock: clockConfig,
      requestId: 'req_clock_schema_strict'
    }
  });

  assert(result.processedRequest, 'expected processedRequest');
  const processed = result.processedRequest;
  const tools = Array.isArray(processed.tools) ? processed.tools : [];
  const clockTool = tools.find((t) => t?.function?.name === 'clock');
  assert(clockTool, 'expected clock tool to be injected');
  assert(clockTool.function.strict === true, 'expected clock tool strict=true');

  const schema = clockTool.function.parameters;
  walkStrictSchema(schema, 'clock.parameters');

  console.log('✅ clock-tool-schema-openai-strict ok');
}

main().catch((err) => {
  console.error('❌ clock-tool-schema-openai-strict failed', err);
  process.exit(1);
});

