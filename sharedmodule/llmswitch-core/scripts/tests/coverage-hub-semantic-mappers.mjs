#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const target = process.env.SEMANTIC_MAPPER_TARGET || 'family';

function includesTarget(name) {
  return target === 'family' || target === name;
}

function moduleUrl(relPath) {
  return pathToFileURL(path.join(repoRoot, 'dist', relPath)).href;
}

function runNodeScript(relPath) {
  const scriptPath = path.join(repoRoot, relPath);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env }
  });
  if (result.status !== 0) {
    throw new Error(`failed: ${relPath} (exit=${result.status ?? 'null'})`);
  }
}

async function runAnthropicHelperCoverage() {
  const thinking = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/anthropic-thinking-config.js'));
  const audit = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/anthropic-semantics-audit.js'));

  assert.equal(thinking.normalizeAnthropicThinkingConfigFromUnknown(undefined), undefined);
  assert.equal(thinking.normalizeAnthropicThinkingConfigFromUnknown(null), undefined);
  assert.deepEqual(thinking.normalizeAnthropicThinkingConfigFromUnknown(true), { mode: 'enabled', budgetTokens: 1024 });
  assert.deepEqual(thinking.normalizeAnthropicThinkingConfigFromUnknown(false), { mode: 'disabled' });
  assert.equal(thinking.normalizeAnthropicThinkingConfigFromUnknown(''), undefined);
  assert.deepEqual(thinking.normalizeAnthropicThinkingConfigFromUnknown('off'), { mode: 'disabled' });
  assert.deepEqual(thinking.normalizeAnthropicThinkingConfigFromUnknown('enabled'), { mode: 'enabled' });
  assert.deepEqual(thinking.normalizeAnthropicThinkingConfigFromUnknown('adaptive'), { mode: 'adaptive' });
  assert.deepEqual(
    thinking.normalizeAnthropicThinkingConfigFromUnknown('high', { effortDefaultsToAdaptive: true }),
    { mode: 'adaptive', effort: 'high' }
  );
  assert.deepEqual(
    thinking.normalizeAnthropicThinkingConfigFromUnknown('minimal', { effortDefaultsToAdaptive: true }),
    { mode: 'adaptive', effort: 'low' }
  );
  assert.deepEqual(thinking.normalizeAnthropicThinkingConfigFromUnknown(0), { mode: 'disabled' });
  assert.deepEqual(thinking.normalizeAnthropicThinkingConfigFromUnknown(1), { mode: 'enabled', budgetTokens: 1024 });
  assert.deepEqual(thinking.normalizeAnthropicThinkingConfigFromUnknown(2048), { mode: 'enabled', budgetTokens: 2048 });
  assert.deepEqual(
    thinking.normalizeAnthropicThinkingConfigFromUnknown({ enabled: false }),
    { mode: 'disabled' }
  );
  assert.deepEqual(
    thinking.normalizeAnthropicThinkingConfigFromUnknown({ enabled: true }),
    { mode: 'enabled' }
  );
  assert.deepEqual(
    thinking.normalizeAnthropicThinkingConfigFromUnknown({ type: 'adaptive' }),
    { mode: 'adaptive' }
  );
  assert.deepEqual(
    thinking.normalizeAnthropicThinkingConfigFromUnknown({ budget: 12 }),
    { budgetTokens: 1024 }
  );
  assert.deepEqual(
    thinking.normalizeAnthropicThinkingConfigFromUnknown({ max_tokens: 4096 }),
    { budgetTokens: 4096 }
  );
  assert.deepEqual(
    thinking.normalizeAnthropicThinkingConfigFromUnknown({ budget_tokens: 500, level: 'minimal' }),
    { budgetTokens: 1024, effort: 'low' }
  );
  assert.equal(thinking.normalizeAnthropicThinkingConfigFromUnknown([]), undefined);
  assert.deepEqual(
    thinking.mergeAnthropicThinkingConfig({ mode: 'adaptive', effort: 'low' }, { budgetTokens: 4096 }),
    { mode: 'adaptive', effort: 'low', budgetTokens: 4096 }
  );
  assert.deepEqual(
    thinking.mergeAnthropicThinkingConfig({ mode: 'enabled', budgetTokens: 1024 }, undefined),
    { mode: 'enabled', budgetTokens: 1024 }
  );
  assert.deepEqual(
    thinking.resolveConfiguredAnthropicThinkingBudgets({ anthropicThinkingBudgets: { minimal: '16', high: 4096, bad: 'x' } }),
    { low: 1024, high: 4096 }
  );
  assert.deepEqual(
    thinking.resolveConfiguredAnthropicThinkingBudgets({ anthropicThinkingBudgets: { high: {}, low: 2048 } }),
    { low: 2048 }
  );
  assert.equal(thinking.resolveConfiguredAnthropicThinkingBudgets(undefined), undefined);
  assert.equal(thinking.resolveConfiguredAnthropicThinkingBudgets({ anthropicThinkingBudgets: [] }), undefined);
  assert.deepEqual(
    thinking.applyEffortBudget({ mode: 'adaptive', effort: 'high' }, { high: 8192 }),
    { mode: 'enabled', effort: 'high', budgetTokens: 8192 }
  );
  assert.deepEqual(thinking.applyEffortBudget({ mode: 'disabled' }, { high: 8192 }), { mode: 'disabled' });
  assert.deepEqual(thinking.applyEffortBudget(undefined, { high: 8192 }), undefined);
  assert.deepEqual(thinking.applyEffortBudget({ effort: 'medium' }, { high: 8192 }), { effort: 'medium' });
  assert.deepEqual(thinking.applyEffortBudget({}, { high: 8192 }), {});
  assert.deepEqual(thinking.buildAnthropicThinkingFromConfig({ mode: 'disabled' }), { type: 'disabled' });
  assert.deepEqual(thinking.buildAnthropicThinkingFromConfig({ mode: 'adaptive' }), { type: 'adaptive' });
  assert.deepEqual(thinking.buildAnthropicThinkingFromConfig({ mode: 'enabled' }), { type: 'enabled', budget_tokens: 1024 });
  assert.deepEqual(thinking.buildAnthropicThinkingFromConfig({ budgetTokens: 1536 }), { type: 'enabled', budget_tokens: 1536 });
  assert.equal(thinking.buildAnthropicThinkingFromConfig(undefined), undefined);
  assert.equal(thinking.buildAnthropicThinkingFromConfig({ effort: 'high' }), undefined);
  assert.deepEqual(thinking.mergeAnthropicOutputConfig({ format: 'json' }, 'high'), { format: 'json', effort: 'high' });
  assert.deepEqual(thinking.mergeAnthropicOutputConfig('bad', 'low'), { effort: 'low' });
  assert.equal(thinking.mergeAnthropicOutputConfig(undefined, undefined), undefined);
  assert.deepEqual(
    thinking.resolveConfiguredAnthropicThinkingConfig({ anthropicThinkingConfig: { effort: 'medium' } }),
    { effort: 'medium' }
  );
  assert.deepEqual(
    thinking.resolveConfiguredAnthropicThinkingConfig({ anthropicThinking: 'off' }),
    { mode: 'disabled' }
  );
  assert.deepEqual(
    thinking.resolveConfiguredAnthropicThinkingConfig({ reasoningEffort: 'high' }),
    { mode: 'adaptive', effort: 'high' }
  );
  assert.deepEqual(
    thinking.resolveConfiguredAnthropicThinkingConfig({ reasoning_effort: 'max' }),
    { mode: 'adaptive', effort: 'max' }
  );
  assert.equal(thinking.resolveConfiguredAnthropicThinkingConfig({}), undefined);
  assert.equal(thinking.resolveConfiguredAnthropicThinkingConfig('bad'), undefined);

  const chatA = {};
  assert.deepEqual(audit.ensureSemantics(chatA), {});
  assert.equal(audit.ensureSemantics({ semantics: { existing: true } }).existing, true);
  assert.equal(typeof audit.ensureToolsSemanticsNode(chatA), 'object');
  assert.equal(typeof audit.ensureToolsSemanticsNode({ semantics: { tools: { keep: true } } }).keep, 'boolean');
  audit.markExplicitEmptyTools(chatA);
  assert.equal(audit.hasExplicitEmptyToolsSemantics(chatA), true);
  assert.equal(audit.hasExplicitEmptyToolsSemantics({}), false);
  assert.equal(audit.hasExplicitEmptyToolsSemantics({ semantics: { tools: 'bad' } }), false);
  assert.equal(audit.cloneAnthropicSystemBlocks(undefined), undefined);
  assert.equal(audit.cloneAnthropicSystemBlocks([]), undefined);
  assert.deepEqual(audit.cloneAnthropicSystemBlocks('sys'), ['sys']);
  assert.deepEqual(audit.cloneAnthropicSystemBlocks(['a', { text: 'b' }]), ['a', { text: 'b' }]);
  assert.equal(audit.isResponsesOrigin({ semantics: { responses: {} } }), true);
  assert.equal(audit.isResponsesOrigin({ metadata: { context: { providerProtocol: 'openai-responses' } } }), true);
  assert.equal(audit.isResponsesOrigin({ metadata: { context: { entryEndpoint: '/v1/responses' } } }), true);
  assert.equal(audit.isResponsesOrigin({ metadata: { context: { entryEndpoint: '/v1/chat/completions' } } }), false);
  assert.equal(audit.isResponsesOrigin({ metadata: null }), false);
  const audited = { metadata: {} };
  audit.appendDroppedFieldAudit(audited, { field: 'prompt_cache_key', targetProtocol: 'anthropic-messages', reason: 'unsupported' });
  audit.appendDroppedFieldAudit(audited, { field: 'prompt_cache_key', targetProtocol: 'anthropic-messages', reason: 'unsupported' });
  audit.appendLossyFieldAudit(audited, { field: 'reasoning', targetProtocol: 'anthropic-messages', reason: 'normalized' });
  assert.equal(audited.metadata.mappingAudit.dropped.length, 1);
  assert.equal(audited.metadata.mappingAudit.lossy.length, 1);
  const auditedNoMeta = {};
  audit.appendDroppedFieldAudit(auditedNoMeta, { field: 'x', targetProtocol: 'anthropic-messages', reason: 'drop' });
  assert.equal(auditedNoMeta.metadata.mappingAudit.dropped.length, 1);
  const auditedPrimitiveMeta = { metadata: 'bad' };
  audit.appendLossyFieldAudit(auditedPrimitiveMeta, { field: 'y', targetProtocol: 'anthropic-messages', reason: 'loss' });
  assert.equal(auditedPrimitiveMeta.metadata.mappingAudit.lossy.length, 1);
}

async function runGeminiHelperCoverage() {
  const antigravity = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/gemini-antigravity-request.js'));
  const systemSem = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/gemini-system-semantics.js'));
  const thinking = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/gemini-thinking-config.js'));
  const chatHelpers = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/gemini-chat-request-helpers.js'));
  const toolOutput = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/gemini-tool-output.js'));
  const audit = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/gemini-mapping-audit.js'));
  const state = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/gemini-semantics-state.js'));

  assert.equal(antigravity.stripOnlineSuffix('gemini-pro-online'), 'gemini-pro');
  const reqNoTools = {};
  antigravity.injectGoogleSearchTool(reqNoTools);
  assert.deepEqual(reqNoTools.tools, [{ googleSearch: {} }]);
  const reqWithDecls = { tools: [{ functionDeclarations: [{ name: 'exec_command' }] }] };
  antigravity.injectGoogleSearchTool(reqWithDecls);
  assert.equal(reqWithDecls.tools.length, 1);
  const reqPrune = { tools: [{ functionDeclarations: [{ name: 'web_search' }, { name: 'exec_command' }] }, { functionDeclarations: [{ name: 'websearch' }] }] };
  antigravity.pruneSearchFunctionDeclarations(reqPrune);
  assert.equal(reqPrune.tools.length, 1);
  assert.equal(reqPrune.tools[0].functionDeclarations[0].name, 'exec_command');
  const undefNode = { a: '[undefined]', nested: { b: '[undefined]', ok: 1 }, arr: [{ c: '[undefined]' }] };
  antigravity.deepCleanUndefined(undefNode);
  assert.equal('a' in undefNode, false);
  assert.equal('b' in undefNode.nested, false);
  assert.equal('c' in undefNode.arr[0], false);
  const imageCfg = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro-image-16x9-4k-online',
    mappedModel: 'gemini-3-pro-image-online'
  });
  assert.equal(imageCfg.requestType, 'image_gen');
  assert.equal(imageCfg.finalModel, 'gemini-3-pro-image');
  assert.equal(imageCfg.imageConfig.aspectRatio, '16:9');
  const webCfg = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro-online',
    mappedModel: 'gemini-3-pro-online',
    tools: [{ function: { name: 'web_search' } }]
  });
  assert.equal(webCfg.requestType, 'web_search');
  const agentCfg = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro-preview',
    mappedModel: 'gemini-3-pro-preview'
  });
  assert.equal(agentCfg.requestType, 'agent');
  assert.equal(agentCfg.finalModel, 'gemini-3-pro-high');

  const gemChat = {};
  assert.equal(typeof systemSem.ensureSystemSemantics(gemChat), 'object');
  gemChat.semantics.system.textBlocks = ['a', '', 1, 'b'];
  assert.deepEqual(systemSem.readSystemTextBlocksFromSemantics(gemChat), ['a', 'b']);
  assert.deepEqual(systemSem.collectSystemSegments({ parts: [{ text: 'sys1' }, { parts: [{ text: 'sys2' }] }] }), ['sys1\nsys2']);
  const req1 = {};
  systemSem.applyGeminiRequestSystemInstruction({ request: req1, isAntigravityProvider: false, semanticsSystemInstruction: { parts: [{ text: 'x' }] } });
  assert.equal(req1.systemInstruction.parts[0].text, 'x');
  const req2 = {};
  systemSem.applyGeminiRequestSystemInstruction({ request: req2, isAntigravityProvider: false, protocolStateSystemInstruction: { parts: [{ text: 'y' }] } });
  assert.equal(req2.systemInstruction.parts[0].text, 'y');
  const req3 = {};
  systemSem.applyGeminiRequestSystemInstruction({ request: req3, isAntigravityProvider: false, systemTextBlocksFromSemantics: ['a', 'b'] });
  assert.equal(req3.systemInstruction.parts.length, 2);
  const req4 = {};
  systemSem.applyGeminiRequestSystemInstruction({ request: req4, isAntigravityProvider: true, semanticsSystemInstruction: 'extra', protocolStateSystemInstruction: 'extra', systemTextBlocksFromSemantics: ['extra', 'more'] });
  assert.match(req4.systemInstruction.parts[0].text, /Antigravity/);
  assert.equal(req4.systemInstruction.parts.length, 2);
  const req5 = {};
  systemSem.applyGeminiRequestSystemInstruction({ request: req5, isAntigravityProvider: true });
  assert.match(req5.systemInstruction.parts[0].text, /Antigravity/);

  assert.equal(thinking.buildGenerationConfigFromParameters({ temperature: 0.1 }).temperature, 0.1);
  assert.equal(thinking.buildGenerationConfigFromParameters({ max_tokens: 88 }).maxOutputTokens, 88);
  assert.deepEqual(thinking.buildGenerationConfigFromParameters({ reasoning: false }).thinkingConfig, { includeThoughts: false, thinkingBudget: 0 });
  assert.equal(thinking.buildGenerationConfigFromParameters({ reasoning: 'high' }).thinkingConfig.thinkingBudget, 8192);
  assert.equal(thinking.buildGenerationConfigFromParameters({ reasoning: 2048 }).thinkingConfig.thinkingBudget, 2048);
  assert.deepEqual(thinking.buildGenerationConfigFromParameters({ reasoning: { enabled: false } }).thinkingConfig, { includeThoughts: false, thinkingBudget: 0 });
  assert.equal(thinking.buildGenerationConfigFromParameters({ reasoning: { budget_tokens: 1234 } }).thinkingConfig.thinkingBudget, 1234);
  const flashReq = { generationConfig: { thinkingConfig: { thinkingBudget: 999999 } } };
  thinking.applyAntigravityThinkingConfig(flashReq, 'gemini-3-flash');
  assert.equal(flashReq.generationConfig.thinkingConfig.thinkingBudget, antigravity.GEMINI_FLASH_DEFAULT_THINKING_BUDGET);
  const flashReq2 = { generationConfig: {} };
  thinking.applyAntigravityThinkingConfig(flashReq2, 'gemini-3-flash');
  assert.equal(flashReq2.generationConfig.thinkingConfig.includeThoughts, true);
  const claudeToolReq = { generationConfig: {}, contents: [{ parts: [{ functionCall: { name: 'x' } }] }] };
  thinking.applyAntigravityThinkingConfig(claudeToolReq, 'claude-sonnet-4-5-thinking');
  assert.equal(claudeToolReq.generationConfig.thinkingConfig, undefined);
  const claudePlainReq = { generationConfig: { thinkingConfig: { thinkingLevel: 'high' } }, contents: [{ parts: [{ text: 'hi' }] }] };
  thinking.applyAntigravityThinkingConfig(claudePlainReq, 'claude-sonnet-4-5-thinking');
  assert.equal(claudePlainReq.generationConfig.thinkingConfig.includeThoughts, true);
  assert.equal('thinkingLevel' in claudePlainReq.generationConfig.thinkingConfig, false);
  const imageReq = { requestType: 'image_gen' };
  thinking.applyAntigravityThinkingConfig(imageReq, 'gemini-image');
  assert.equal(imageReq.generationConfig, undefined);

  const defs = chatHelpers.buildToolSchemaKeyMap([
    { function: { name: 'exec_command', parameters: { properties: { cmd: {}, workdir: {} } } } },
    { function: { name: 'apply_patch', parameters: { properties: { instructions: {}, patch: {} } } } },
    { name: 'ignored', parameters: null }
  ]);
  assert.equal(defs.get('exec_command').has('cmd'), true);
  assert.deepEqual(chatHelpers.alignToolCallArgsToSchema({ toolName: 'exec_command', args: { command: 'ls', noise: 1 }, schemaKeys: defs }), { cmd: 'ls' });
  assert.deepEqual(chatHelpers.alignToolCallArgsToSchema({ toolName: 'write_stdin', args: { text: 'hi' }, schemaKeys: new Map([['write_stdin', new Set(['chars'])]]) }), { chars: 'hi' });
  assert.deepEqual(chatHelpers.alignToolCallArgsToSchema({ toolName: 'apply_patch', args: { input: 'patch-body' }, schemaKeys: defs }), { instructions: 'patch-body', patch: 'patch-body' });
  assert.equal(chatHelpers.mapChatRoleToGemini('assistant'), 'model');
  assert.equal(chatHelpers.mapToolNameForGemini('web_search_20250305'), 'websearch');
  assert.deepEqual([...chatHelpers.collectAssistantToolCallIds([{ role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'x' } }] }, { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'x' } }, { id: 'b', function: { name: 'y' } }] }])].sort(), ['a', 'b']);
  assert.equal(chatHelpers.isResponsesOrigin({ semantics: { responses: {} } }), true);
  assert.equal(chatHelpers.isResponsesOrigin({ metadata: { context: { entryEndpoint: '/v1/responses' } } }), true);
  assert.equal(chatHelpers.isResponsesOrigin({ metadata: { context: { entryEndpoint: '/v1/chat/completions' } } }), false);
  const gemParams = chatHelpers.collectParameters({ model: 'gemini-pro', generationConfig: { temperature: 0.2, topK: 40 }, toolConfig: { functionCallingConfig: {} }, metadata: { __rcc_stream: 1 } });
  assert.equal(gemParams.model, 'gemini-pro');
  assert.equal(gemParams.top_k, 40);
  assert.equal(gemParams.stream, true);
  const parts = [];
  const circular = { type: 'other' };
  circular.self = circular;
  chatHelpers.appendChatContentToGeminiParts({
    role: 'user',
    content: [' raw ', 7, { text: 'txt' }, { type: 'image', image_url: 'data:image/png;base64,abc' }, { type: 'image_url', url: 'https://x/y.png' }, { type: 'image', image_url: '' }, circular]
  }, parts, { stripReasoningTags: true });
  assert.equal(parts.some((p) => p.text === 'raw'), true);
  assert.equal(parts.some((p) => p.inlineData?.data === 'abc'), true);
  assert.equal(parts.some((p) => p.text === 'https://x/y.png'), true);
  assert.equal(parts.some((p) => p.text === '[image]'), true);

  const missing = [];
  const outputs = toolOutput.normalizeToolOutputs([
    { role: 'tool', tool_call_id: 'tool-1', content: { ok: true }, name: 'apply_patch' },
    { role: 'tool', content: 'oops' }
  ], missing);
  assert.equal(outputs.length, 1);
  assert.equal(missing.length, 1);
  assert.equal(toolOutput.synthesizeToolOutputsFromMessages([{ role: 'assistant', tool_calls: [{ id: 'x', function: { name: 'fn' } }, { id: 'x', function: { name: 'fn' } }] }]).length, 1);
  const circ2 = {}; circ2.self = circ2;
  assert.match(toolOutput.normalizeToolContent(circ2), /\[object Object\]|self/);
  assert.equal(toolOutput.convertToolMessageToOutput({ id: 'x', content: 'ok' }, new Set(['y'])), null);
  assert.equal(toolOutput.convertToolMessageToOutput({ id: 'x', content: 'ok' }, new Set(['x'])).tool_call_id, 'x');
  assert.equal(toolOutput.sanitizeAntigravityToolCallId('  bad id!*  '), 'bad_id');
  assert.equal(toolOutput.sanitizeAntigravityToolCallId('clean_id'), 'clean_id');
  const cloned = toolOutput.cloneAsJsonValue({ big: 1n, nested: [1, 'x'] });
  assert.equal(cloned.big, '1');
  const fr1 = toolOutput.buildFunctionResponseEntry({ tool_call_id: 'bad id!*', content: '[1,2]', name: 'toolA' }, { includeCallId: true });
  assert.equal(fr1.parts[0].functionResponse.id, 'bad_id');
  const fr2 = toolOutput.buildFunctionResponseEntry({ tool_call_id: 't2', content: 'not-json', name: 'toolB' });
  assert.equal(fr2.parts[0].functionResponse.response.result, 'not-json');

  const auditChat = { metadata: {} };
  audit.appendDroppedFieldAudit(auditChat, { field: 'x', targetProtocol: 'gemini-chat', reason: 'drop' });
  audit.appendDroppedFieldAudit(auditChat, { field: 'x', targetProtocol: 'gemini-chat', reason: 'drop' });
  audit.appendLossyFieldAudit(auditChat, { field: 'y', targetProtocol: 'gemini-chat', reason: 'loss' });
  assert.equal(auditChat.metadata.mappingAudit.dropped.length, 1);
  assert.equal(auditChat.metadata.mappingAudit.lossy.length, 1);

  const gemStateChat = {};
  assert.equal(typeof state.ensureGeminiSemanticsNode(gemStateChat), 'object');
  state.markGeminiExplicitEmptyTools(gemStateChat);
  assert.equal(state.hasExplicitEmptyToolsSemantics(gemStateChat), true);
  assert.equal(state.readGeminiSemantics(gemStateChat) !== undefined, true);
  assert.equal(state.readGeminiSemantics({}), undefined);
}

async function runResponsesSubmitCoverage() {
  const submit = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/responses-submit-tool-outputs.js'));

  assert.equal(submit.isSubmitToolOutputsEndpoint({ entryEndpoint: '/v1/responses.submit_tool_outputs' }), true);
  assert.equal(submit.isSubmitToolOutputsEndpoint({ entryEndpoint: '/v1/responses' }), false);

  const payload1 = submit.buildSubmitToolOutputsPayload(
    {
      messages: [{ role: 'user', content: 'hi' }],
      parameters: { model: 'gpt-4o-mini', stream: true },
      toolOutputs: [{ tool_call_id: 'tool-1', content: '{"ok":true}', name: 'shell_command' }],
      semantics: { responses: { context: { metadata: { originalEndpoint: 'openai-responses' } } } }
    },
    { entryEndpoint: '/v1/responses.submit_tool_outputs' },
    { previous_response_id: 'resp-prev', metadata: { originalEndpoint: 'openai-responses' } }
  );
  assert.equal(payload1.response_id, 'resp-prev');
  assert.equal(payload1.tool_outputs[0].tool_call_id, 'tool-1');
  assert.equal(payload1.stream, true);
  assert.equal(payload1.model, 'gpt-4o-mini');

  const payload2 = submit.buildSubmitToolOutputsPayload(
    {
      messages: [{ role: 'user', content: 'hi' }],
      parameters: { model: 'gpt-4o-mini' },
      semantics: { responses: { resume: { restoredFromResponseId: 'resp-resume', metadata: { from: 'resume' } } } }
    },
    { entryEndpoint: '/v1/responses.submit_tool_outputs' },
    { __captured_tool_results: [{ call_id: 'cap-1', output: { ok: true }, name: 'cap' }] }
  );
  assert.equal(payload2.response_id, 'resp-resume');
  assert.equal(payload2.tool_outputs[0].tool_call_id, 'cap-1');
  assert.equal(payload2.metadata.from, 'resume');

  const payload3 = submit.buildSubmitToolOutputsPayload(
    {
      messages: [{ role: 'user', content: 'hi' }],
      parameters: { model: 'gpt-4o-mini' },
      semantics: { responses: { resume: { restoredFromResponseId: 'resp-fallback', toolOutputsDetailed: [{ callId: 'resume-1', outputText: 'fallback' }] } } }
    },
    { entryEndpoint: '/v1/responses.submit_tool_outputs' },
    {}
  );
  assert.equal(payload3.response_id, 'resp-fallback');
  assert.equal(payload3.tool_outputs[0].tool_call_id, 'resume-1');
  assert.equal(payload3.tool_outputs[0].output, 'fallback');

  assert.throws(
    () => submit.buildSubmitToolOutputsPayload({ messages: [], parameters: {}, semantics: { responses: { context: {} } } }, { entryEndpoint: '/v1/responses.submit_tool_outputs' }, {}),
    /response_id/
  );
}

async function runResponsesMainCoverage() {
  const { ResponsesSemanticMapper } = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/responses-mapper.js'));
  const mapper = new ResponsesSemanticMapper();
  const ctx = {
    requestId: 'semantic-coverage-responses',
    providerProtocol: 'openai-responses',
    entryEndpoint: '/v1/responses'
  };

  const inbound = await mapper.toChat(
    {
      protocol: 'openai-responses',
      direction: 'request',
      payload: {
        model: 'gpt-4o-mini',
        input: 'oops',
        tool_outputs: [123, { output: 'missing-id' }, { id: 'tool-1', output: { ok: true }, name: 'apply_patch' }],
        tools: [123],
        metadata: { source: 'coverage' },
        stream: true
      }
    },
    ctx
  );
  assert.equal(inbound.messages.length, 1);
  assert.equal(inbound.messages[0].content, 'oops');
  assert.equal(inbound.toolOutputs?.length, 1);
  assert.equal(inbound.toolOutputs?.[0]?.tool_call_id, 'tool-1');
  assert.equal(inbound.metadata?.missingFields?.length, 2);
  assert.equal(typeof inbound.semantics?.responses, 'object');

  const outbound = await mapper.fromChat(
    {
      messages: [
        { role: 'system', content: ['sys-', { text: 'json' }] },
        { role: 'user', content: { nested: true } }
      ],
      parameters: { model: 'gpt-4o-mini', stream: false },
      metadata: { context: ctx, fromEnvelope: 1 },
      semantics: {
        responses: {
          context: {
            metadata: { fromSemantics: 1 }
          }
        }
      }
    },
    ctx
  );
  assert.equal(outbound.payload.model, 'gpt-4o-mini');
  assert.equal(outbound.payload.stream, false);
  assert.equal(outbound.payload.instructions, 'sys-json');
  assert.equal(outbound.payload.metadata.fromSemantics, 1);
  assert.equal(outbound.payload.metadata.fromEnvelope, 1);

  await assert.rejects(
    () =>
      mapper.fromChat(
        {
          messages: [],
          parameters: {}
        },
        ctx
      ),
    /parameters\.model is required/
  );
}

async function runAnthropicMainCoverage() {
  const { AnthropicSemanticMapper } = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/anthropic-mapper.js'));
  const mapper = new AnthropicSemanticMapper();
  const ctx = {
    requestId: 'semantic-coverage-anthropic',
    providerProtocol: 'anthropic-messages',
    entryEndpoint: '/v1/messages',
    anthropicThinkingConfig: { effort: 'high' },
    anthropicThinkingBudgets: { high: 4096 }
  };

  const inbound = await mapper.toChat(
    {
      protocol: 'anthropic-messages',
      direction: 'request',
      payload: {
        system: ['sys', { type: 'text', text: 'two' }],
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
          { role: 'assistant', content: { foo: 'bar' } },
          { role: 'user', content: null },
          5
        ],
        tools: [],
        metadata: { foo: 'bar', rcc_passthrough_tool_choice: 'auto' },
        max_tokens: 10,
        stop_sequences: ['a']
      }
    },
    ctx
  );
  assert.equal(inbound.messages[0].role, 'system');
  assert.equal(inbound.messages[1].role, 'system');
  assert.deepEqual(inbound.semantics?.system?.textBlocks, ['sys', 'two']);
  assert.equal(inbound.semantics?.tools?.explicitEmpty, true);
  assert.deepEqual(inbound.semantics?.providerExtras?.anthropicMirror?.messageContentShape, ['string', 'array', 'object', 'null', 'unknown']);
  assert.equal(inbound.metadata?.missingFields?.some((entry) => entry.path === 'model'), true);

  const outbound = await mapper.fromChat(
    {
      messages: [{ role: 'user', content: 'u' }],
      tools: [],
      parameters: {
        model: 'claude-x',
        prompt_cache_key: 'pc',
        response_format: { type: 'json' },
        reasoning: 'high',
        max_output_tokens: 123,
        tool_choice: 'auto'
      },
      semantics: {
        responses: {},
        system: { blocks: ['s1'] },
        providerExtras: {
          anthropicMirror: { shape: 1 },
          providerMetadata: { keep: 'yes' }
        },
        tools: { explicitEmpty: true }
      },
      metadata: { context: ctx }
    },
    ctx
  );
  assert.equal(outbound.payload.model, 'claude-x');
  assert.equal(outbound.payload.max_tokens, 123);
  assert.equal(outbound.payload.output_config.effort, 'high');
  assert.equal(outbound.payload.thinking.budget_tokens, 4096);
  assert.equal(outbound.payload.metadata.keep, 'yes');
  assert.equal(outbound.payload.metadata.rcc_passthrough_tool_choice, '"auto"');
  assert.equal(outbound.payload.tool_choice.type, 'auto');
  assert.equal(Array.isArray(outbound.payload.system), true);

  const inboundDefaultCtx = await mapper.toChat(
    {
      protocol: 'anthropic-messages',
      direction: 'request',
      payload: {
        model: 'claude-clean',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          {
            name: 'lookup_docs',
            description: 'Lookup docs',
            input_schema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query']
            }
          }
        ]
      }
    },
    {
      requestId: 'semantic-coverage-anthropic-default',
      providerProtocol: 'anthropic-messages'
    }
  );
  assert.equal(inboundDefaultCtx.metadata.context.entryEndpoint, '/v1/chat/completions');
  assert.equal(inboundDefaultCtx.parameters.model, 'claude-clean');
  assert.equal(Array.isArray(inboundDefaultCtx.tools), true);

  const inboundPassthrough = await mapper.toChat(
    {
      protocol: 'anthropic-messages',
      direction: 'request',
      payload: {
        messages: [{ role: 'user', content: 'pt' }],
        metadata: { rcc_passthrough_tool_choice: '"auto"' }
      }
    },
    {
      requestId: 'semantic-coverage-anthropic-passthrough',
      providerProtocol: 'anthropic-messages',
      entryEndpoint: '/v1/messages'
    }
  );
  assert.equal(inboundPassthrough.parameters.tool_choice, 'auto');
  assert.equal(inboundPassthrough.parameters.metadata.rcc_passthrough_tool_choice, '"auto"');

  const inboundNoParams = await mapper.toChat(
    {
      protocol: 'anthropic-messages',
      direction: 'request',
      payload: {
        messages: [{ role: 'user', content: 'noparams' }]
      }
    },
    {
      requestId: 'semantic-coverage-anthropic-noparams',
      providerProtocol: 'anthropic-messages',
      entryEndpoint: '/v1/messages'
    }
  );
  assert.equal(inboundNoParams.parameters, undefined);

  const outboundPlain = await mapper.fromChat(
    {
      messages: [{ role: 'user', content: 'plain' }],
      parameters: { model: 'claude-plain', metadata: 'bad-shape', stop: ['done'] },
      semantics: { providerExtras: { providerMetadata: { restored: true } } }
    },
    {
      requestId: 'semantic-coverage-anthropic-plain',
      providerProtocol: 'anthropic-messages',
      entryEndpoint: '/v1/messages'
    }
  );
  assert.equal(outboundPlain.payload.model, 'claude-plain');
  assert.equal(outboundPlain.payload.metadata.restored, true);
  assert.equal(Array.isArray(outboundPlain.payload.stop_sequences), true);
  assert.equal(outboundPlain.payload.thinking, undefined);

  const throwingSemantics = {};
  Object.defineProperty(throwingSemantics, 'system', {
    get() {
      throw new Error('system-read-failed');
    }
  });
  Object.defineProperty(throwingSemantics, 'providerExtras', {
    get() {
      throw new Error('extras-read-failed');
    }
  });
  const outboundGuarded = await mapper.fromChat(
    {
      messages: [{ role: 'user', content: 'guarded' }],
      tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
      parameters: {
        model: 'claude-guarded',
        metadata: { base: 1 },
        tool_choice: 'auto',
        thinking: { type: 'enabled', budget_tokens: 2048 },
        output_config: { format: 'json' },
        max_tokens: 50,
        messages: ['ignored'],
        tools: ['ignored']
      },
      semantics: throwingSemantics
    },
    {
      requestId: 'semantic-coverage-anthropic-guarded',
      providerProtocol: 'anthropic-messages',
      entryEndpoint: '/v1/messages'
    }
  );
  assert.equal(outboundGuarded.payload.model, 'claude-guarded');
  assert.equal(outboundGuarded.payload.max_tokens, 50);
  assert.equal(outboundGuarded.payload.metadata.base, 1);
  assert.equal(outboundGuarded.payload.metadata.rcc_passthrough_tool_choice, '"auto"');
  assert.equal(outboundGuarded.payload.thinking.type, 'enabled');
  assert.equal(outboundGuarded.payload.output_config.format, 'json');

  await assert.rejects(
    () =>
      mapper.fromChat(
        {
          messages: [{ role: 'user', content: 'x' }],
          parameters: {}
        },
        ctx
      ),
    /parameters\.model is required/
  );
}

async function runGeminiMainCoverage() {
  const { GeminiSemanticMapper } = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/gemini-mapper.js'));
  const mapper = new GeminiSemanticMapper();
  const ctx = {
    requestId: 'semantic-coverage-gemini',
    providerProtocol: 'gemini-chat',
    entryEndpoint: '/v1beta/models/test:generateContent'
  };

  const inbound = await mapper.toChat(
    {
      protocol: 'gemini-chat',
      direction: 'request',
      payload: {
        contents: [
          { role: 'user', parts: [{ text: 'hi' }] },
          { role: 'model', parts: [{ functionCall: { name: 'web_search_20250305', args: { query: 'q' }, id: 'bad id' } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'web_search_20250305', id: 'bad id', response: { ok: true } } }] },
          { role: 'tool', parts: [{ text: 'legacy' }] }
        ],
        tools: [],
        metadata: { __rcc_tools_field_present: '1', foo: 'bar', rcc_passthrough_tool_choice: 'auto' },
        systemInstruction: { parts: [{ text: 'sys' }] },
        safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }],
        generationConfig: { temperature: 0.1 },
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
      }
    },
    ctx
  );
  assert.equal(inbound.messages[0].role, 'system');
  assert.equal(inbound.toolOutputs?.[0]?.tool_call_id, 'bad id');
  assert.equal(inbound.metadata?.providerMetadata?.foo, 'bar');
  assert.equal(inbound.semantics?.gemini?.toolConfig?.functionCallingConfig?.mode, 'AUTO');
  assert.equal(inbound.semantics?.tools?.explicitEmpty, true);

  const antigravity = await mapper.fromChat(
    {
      messages: [
        { role: 'system', content: ['s1', { text: 's2' }] },
        {
          role: 'assistant',
          content: 'thinking <think>x</think>',
          tool_calls: [{ id: 'bad id', function: { name: 'web_search_20250305', arguments: '{"query":"q"}' } }]
        },
        { role: 'tool', tool_call_id: 'bad id', name: 'web_search_20250305', content: { result: 'ok' } },
        { role: 'user', content: ['raw', { text: 'https://x/y.png' }] }
      ],
      tools: [],
      toolOutputs: [{ tool_call_id: 'manual-1', name: 'web_search_20250305', content: 'manual' }],
      parameters: {
        model: 'claude-sonnet-4-5-thinking-online',
        reasoning: 'high',
        prompt_cache_key: 'pc',
        keep_reasoning: false,
        stream: true,
        tool_choice: 'auto',
        size: '1792x1024',
        quality: 'high'
      },
      semantics: {
        responses: {},
        system: { textBlocks: ['s3'] }
      },
      metadata: {
        context: { ...ctx, providerId: 'antigravity.any' },
        providerMetadata: { meta: 'ctx' },
        protocolState: { gemini: { systemInstruction: { parts: [{ text: 'proto-sys' }] } } }
      }
    },
    { ...ctx, providerId: 'antigravity.any' }
  );
  assert.equal(antigravity.payload.requestType, 'web_search');
  assert.equal(antigravity.payload.model, 'claude-sonnet-4-5-thinking');
  assert.equal(antigravity.payload.generationConfig.maxOutputTokens, 64000);
  assert.equal(antigravity.payload.metadata.__rcc_stream, true);
  assert.equal(typeof antigravity.payload.metadata.antigravitySessionId, 'string');
  assert.equal(antigravity.payload.tools[0].googleSearch.constructor, Object);

  const imageGen = await mapper.fromChat(
    {
      messages: [{ role: 'user', content: 'draw' }],
      parameters: { model: 'gemini-3-pro-image-16x9-4k-online', size: '1792x1024', quality: 'high' },
      metadata: { context: { ...ctx, providerId: 'antigravity.any' } }
    },
    { ...ctx, providerId: 'antigravity.any' }
  );
  assert.equal(imageGen.payload.requestType, 'image_gen');
  assert.equal(Array.isArray(imageGen.payload.tools), false);
  assert.equal(imageGen.payload.generationConfig.imageConfig.aspectRatio, '16:9');

  const cli = await mapper.fromChat(
    {
      messages: [
        { role: 'tool', name: 'toolx', content: 'oops' },
        { role: 'assistant', content: 'done', tool_calls: [{ id: 't1', function: { name: 'request_user_input', arguments: '{"x":1}' } }] }
      ],
      parameters: { model: 'models/gemini-pro' },
      metadata: {
        context: { ...ctx, providerId: 'gemini-cli.any', entryEndpoint: '/v1/messages' },
        providerMetadata: { meta: 'blocked' }
      },
      semantics: { gemini: { providerMetadata: { sem: 'blocked' } } }
    },
    { ...ctx, providerId: 'gemini-cli.any', entryEndpoint: '/v1/messages' }
  );
  assert.equal(cli.payload.contents[0].parts[0].text, '[tool:toolx] oops');
  assert.equal(cli.payload.contents[1].parts[0].text, 'done');
  assert.equal(cli.payload.metadata, undefined);
}

async function main() {
  runNodeScript('scripts/tests/semantic-mapper-core-replay.mjs');
  runNodeScript('scripts/tests/semantic-mapper-public-replay.mjs');
  if (includesTarget('responses')) {
    await runResponsesMainCoverage();
    await runResponsesSubmitCoverage();
  }
  if (includesTarget('anthropic')) {
    await runAnthropicMainCoverage();
    await runAnthropicHelperCoverage();
  }
  if (includesTarget('gemini')) {
    await runGeminiMainCoverage();
    await runGeminiHelperCoverage();
  }
  console.log(`✅ semantic-mapper ${target} coverage replay passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
