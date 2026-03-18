#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const nativeNodePath = path.join(repoRoot, 'dist', 'native', 'router_hotpath_napi.node');

function moduleUrl(relPath) {
  return pathToFileURL(path.join(repoRoot, 'dist', relPath)).href;
}

function cacheBustedImport(url, tag) {
  return import(`${url}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeNativeMockSource(overrides) {
  return [
    `const real = require(${JSON.stringify(nativeNodePath)});`,
    'module.exports = {',
    '  ...real,',
    ...overrides.map((line) => `  ${line}`),
    '};'
  ].join('\n');
}

async function withTempNativeModule(content, run) {
  const previous = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-tool-governance-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = file;
    await run(file);
  } finally {
    if (previous === undefined) {
      delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
    } else {
      process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = previous;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function buildComparePayload() {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          tool_calls: [{ function: { name: 'TOOL_NAME', arguments: '{}' } }],
          function_call: { name: 'NAME_01', arguments: '{}' }
        }
      }
    ]
  };
}

async function main() {
  // Scenario A: well-formed native registry + successful request/response governance.
  await withTempNativeModule(
    makeNativeMockSource([
      `resolveDefaultToolGovernanceRulesJson() { return JSON.stringify({
        "openai-chat": {
          request: { maxNameLength: 32, allowedCharacters: "alpha_numeric", defaultName: "chat_req", trimWhitespace: true, onViolation: "truncate" },
          response: { maxNameLength: 24, allowedCharacters: "alpha_numeric", defaultName: "chat_resp", trimWhitespace: true, onViolation: "truncate" }
        },
        "openai-responses": {
          request: null,
          response: { maxNameLength: 20, allowedCharacters: "alpha_numeric", defaultName: "resp", trimWhitespace: true, onViolation: "truncate" }
        },
        anthropic: {
          request: { maxNameLength: 18, allowedCharacters: "lower_snake", defaultName: "anth_req", trimWhitespace: true, forceCase: "lower", onViolation: "reject" },
          response: { maxNameLength: 12, allowedCharacters: "lower_snake", defaultName: "anth_resp", trimWhitespace: true, forceCase: "lower", onViolation: "truncate" }
        },
        gemini: {
          request: { maxNameLength: "bad", allowedCharacters: "alpha_numeric", defaultName: "  ", trimWhitespace: true, onViolation: "truncate" },
          response: null
        }
      }); },`,
      `governRequestJson(inputJson) {
        const input = JSON.parse(inputJson);
        return JSON.stringify({
          request: input.request,
          summary: {
            protocol: input.protocol || "openai-chat",
            direction: "request",
            applied: true,
            sanitizedNames: 1,
            truncatedNames: 0,
            defaultedNames: 0,
            timestamp: Date.now()
          }
        });
      },`,
      `governToolNameResponseJson(inputJson) {
        const input = JSON.parse(inputJson);
        return JSON.stringify({
          payload: input.payload,
          summary: {
            protocol: input.protocol || "openai-chat",
            direction: "response",
            applied: true,
            sanitizedNames: 1,
            truncatedNames: 0,
            defaultedNames: 0,
            timestamp: Date.now()
          }
        });
      },`
    ]),
    async () => {
      const rulesMod = await cacheBustedImport(
        moduleUrl('conversion/hub/tool-governance/rules.js'),
        'tool-governance-rules-a'
      );
      const engineMod = await cacheBustedImport(
        moduleUrl('conversion/hub/tool-governance/engine.js'),
        'tool-governance-engine-a'
      );
      const { DEFAULT_TOOL_GOVERNANCE_RULES } = rulesMod;
      const { ToolGovernanceEngine } = engineMod;

      assert.equal(DEFAULT_TOOL_GOVERNANCE_RULES['openai-chat'].request.maxNameLength, 32);
      assert.equal(DEFAULT_TOOL_GOVERNANCE_RULES['openai-responses'].request.maxNameLength, 64);
      assert.equal(DEFAULT_TOOL_GOVERNANCE_RULES['openai-responses'].request.onViolation, 'truncate');
      assert.equal(DEFAULT_TOOL_GOVERNANCE_RULES.gemini.request.maxNameLength, 64);
      assert.equal(DEFAULT_TOOL_GOVERNANCE_RULES.gemini.request.defaultName, 'tool');
      assert.equal(DEFAULT_TOOL_GOVERNANCE_RULES.anthropic.request.forceCase, 'lower');
      assert.equal(DEFAULT_TOOL_GOVERNANCE_RULES.anthropic.request.onViolation, 'reject');

      const engine = new ToolGovernanceEngine(DEFAULT_TOOL_GOVERNANCE_RULES);
      const req = {
        model: 'demo',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        metadata: {},
        parameters: {}
      };
      const payload = buildComparePayload();

      const outResponses = engine.governRequest(clone(req), 'responses');
      assert.equal(outResponses.summary.direction, 'request');
      assert.equal(outResponses.summary.applied, true);

      const outOpenaiResponses = engine.governRequest(clone(req), 'openai-responses');
      assert.equal(outOpenaiResponses.summary.direction, 'request');
      assert.equal(outOpenaiResponses.summary.applied, true);

      const outAnthropic = engine.governRequest(clone(req), 'anthropic-messages');
      assert.equal(outAnthropic.summary.direction, 'request');
      assert.equal(outAnthropic.summary.applied, true);

      const outGemini = engine.governResponse(clone(payload), 'gemini-chat');
      assert.equal(outGemini.summary.direction, 'response');
      assert.equal(outGemini.summary.applied, true);

      const outUnknownProtocol = engine.governRequest(clone(req), 'custom-proto');
      assert.equal(outUnknownProtocol.summary.direction, 'request');
      assert.equal(outUnknownProtocol.summary.applied, true);
    }
  );

  // Scenario B: no matching rules => engine should return pass-through summary with applied=false.
  await withTempNativeModule(
    makeNativeMockSource([
      `resolveDefaultToolGovernanceRulesJson() { return JSON.stringify({}); },`,
      `governRequestJson(inputJson) {
        const input = JSON.parse(inputJson);
        return JSON.stringify({ request: input.request, summary: { protocol: input.protocol || "openai-chat", direction: "request", applied: true, sanitizedNames: 0, truncatedNames: 0, defaultedNames: 0, timestamp: Date.now() } });
      },`,
      `governToolNameResponseJson(inputJson) {
        const input = JSON.parse(inputJson);
        return JSON.stringify({ payload: input.payload, summary: { protocol: input.protocol || "openai-chat", direction: "response", applied: true, sanitizedNames: 0, truncatedNames: 0, defaultedNames: 0, timestamp: Date.now() } });
      },`
    ]),
    async () => {
      const engineMod = await cacheBustedImport(
        moduleUrl('conversion/hub/tool-governance/engine.js'),
        'tool-governance-engine-b'
      );
      const { ToolGovernanceEngine } = engineMod;
      const engine = new ToolGovernanceEngine({});
      const req = { model: 'demo', messages: [], tools: [], metadata: {}, parameters: {} };
      const payload = { choices: [] };
      const reqOut = engine.governRequest(req, 'openai-chat');
      assert.equal(reqOut.summary.applied, false);
      const respOut = engine.governResponse(payload, 'openai-chat');
      assert.equal(respOut.summary.applied, false);
      const emptyProtoOut = engine.governRequest(req, undefined);
      assert.equal(emptyProtoOut.summary.applied, false);
    }
  );

  // Scenario B2: rules fallback with forceCase=true and mixed allowedCharacters tokens.
  await withTempNativeModule(
    makeNativeMockSource([
      `resolveDefaultToolGovernanceRulesJson() { return JSON.stringify({
        "openai-chat": {
          request: { maxNameLength: 7, defaultName: "chat", trimWhitespace: true, onViolation: "truncate" },
          response: { maxNameLength: 9, allowedCharacters: "lower_snake", defaultName: "chat_r", trimWhitespace: true, onViolation: "truncate" }
        },
        "openai-responses": {},
        anthropic: {
          request: null,
          response: null
        },
        gemini: {
          request: { maxNameLength: 11, allowedCharacters: "alpha_numeric", defaultName: "gem", trimWhitespace: true, onViolation: "truncate" },
          response: { maxNameLength: 10, allowedCharacters: "alpha_numeric", defaultName: "gem_r", trimWhitespace: true, onViolation: "truncate" }
        }
      }); },`,
      `governRequestJson(inputJson) {
        const input = JSON.parse(inputJson);
        return JSON.stringify({ request: input.request, summary: { protocol: input.protocol || "openai-chat", direction: "request", applied: true, sanitizedNames: 0, truncatedNames: 0, defaultedNames: 0, timestamp: Date.now() } });
      },`,
      `governToolNameResponseJson(inputJson) {
        const input = JSON.parse(inputJson);
        return JSON.stringify({ payload: input.payload, summary: { protocol: input.protocol || "openai-chat", direction: "response", applied: true, sanitizedNames: 0, truncatedNames: 0, defaultedNames: 0, timestamp: Date.now() } });
      },`
    ]),
    async () => {
      const rulesMod = await cacheBustedImport(
        moduleUrl('conversion/hub/tool-governance/rules.js'),
        'tool-governance-rules-b2'
      );
      const { DEFAULT_TOOL_GOVERNANCE_RULES } = rulesMod;
      assert.equal(DEFAULT_TOOL_GOVERNANCE_RULES.anthropic.request.forceCase, 'lower');
      assert.equal(DEFAULT_TOOL_GOVERNANCE_RULES.anthropic.response.forceCase, 'lower');
      assert.equal(DEFAULT_TOOL_GOVERNANCE_RULES.openaiChat, undefined);
      assert.equal(
        DEFAULT_TOOL_GOVERNANCE_RULES['openai-chat'].response.allowedCharacters.test('a'),
        true
      );
      assert.equal(
        DEFAULT_TOOL_GOVERNANCE_RULES['openai-chat'].response.allowedCharacters.test('A'),
        false
      );
    }
  );

  // Scenario C: "max length" errors should be mapped to ToolGovernanceError.
  await withTempNativeModule(
    makeNativeMockSource([
      `resolveDefaultToolGovernanceRulesJson() { return JSON.stringify({ "openai-chat": { request: { maxNameLength: 8, allowedCharacters: "alpha_numeric", defaultName: "tool", trimWhitespace: true, onViolation: "truncate" }, response: { maxNameLength: 8, allowedCharacters: "alpha_numeric", defaultName: "tool", trimWhitespace: true, onViolation: "truncate" } } }); },`,
      `governRequestJson() { throw new Error("Tool name exceeds max length of 8"); },`,
      `governToolNameResponseJson() { throw new Error("Tool name exceeds max length of 8"); },`
    ]),
    async () => {
      const engineMod = await cacheBustedImport(
        moduleUrl('conversion/hub/tool-governance/engine.js'),
        'tool-governance-engine-c'
      );
      const { ToolGovernanceEngine, ToolGovernanceError } = engineMod;
      const engine = new ToolGovernanceEngine({
        'openai-chat': {
          request: { maxNameLength: 8, allowedCharacters: /[A-Za-z0-9_-]/, defaultName: 'tool', trimWhitespace: true, onViolation: 'truncate' },
          response: { maxNameLength: 8, allowedCharacters: /[A-Za-z0-9_-]/, defaultName: 'tool', trimWhitespace: true, onViolation: 'truncate' }
        }
      });
      assert.throws(
        () => engine.governRequest({ model: 'x', messages: [], tools: [], metadata: {}, parameters: {} }, 'openai-chat'),
        ToolGovernanceError
      );
      assert.throws(() => engine.governResponse({ choices: [] }, 'openai-chat'), ToolGovernanceError);
    }
  );

  // Scenario D: non-max-length errors should be surfaced as-is.
  await withTempNativeModule(
    makeNativeMockSource([
      `resolveDefaultToolGovernanceRulesJson() { return JSON.stringify({ "openai-chat": { request: { maxNameLength: 8, allowedCharacters: "alpha_numeric", defaultName: "tool", trimWhitespace: true, onViolation: "truncate" }, response: { maxNameLength: 8, allowedCharacters: "alpha_numeric", defaultName: "tool", trimWhitespace: true, onViolation: "truncate" } } }); },`,
      `governRequestJson() { throw new Error("boom-request"); },`,
      `governToolNameResponseJson() { throw new Error("boom-response"); },`
    ]),
    async () => {
      const engineMod = await cacheBustedImport(
        moduleUrl('conversion/hub/tool-governance/engine.js'),
        'tool-governance-engine-d'
      );
      const { ToolGovernanceEngine } = engineMod;
      const engine = new ToolGovernanceEngine({
        'openai-chat': {
          request: { maxNameLength: 8, allowedCharacters: /[A-Za-z0-9_-]/, defaultName: 'tool', trimWhitespace: true, onViolation: 'truncate' },
          response: { maxNameLength: 8, allowedCharacters: /[A-Za-z0-9_-]/, defaultName: 'tool', trimWhitespace: true, onViolation: 'truncate' }
        }
      });
      assert.throws(
        () => engine.governRequest({ model: 'x', messages: [], tools: [], metadata: {}, parameters: {} }, 'openai-chat'),
        /boom-request/
      );
      assert.throws(() => engine.governResponse({ choices: [] }, 'openai-chat'), /boom-response/);
    }
  );

  console.log('✅ coverage-hub-tool-governance passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-tool-governance failed:', error);
  process.exit(1);
});
