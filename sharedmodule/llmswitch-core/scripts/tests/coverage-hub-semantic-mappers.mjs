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
  const protocolAudit = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/protocol-mapping-audit.js'));

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
  assert.deepEqual(
    thinking.normalizeAnthropicThinkingConfigFromUnknown({ effort: true }, { effortDefaultsToAdaptive: true }),
    { mode: 'adaptive', effort: 'medium' }
  );
  assert.equal(thinking.normalizeAnthropicThinkingConfigFromUnknown({ effort: false }), undefined);
  assert.equal(thinking.normalizeAnthropicThinkingConfigFromUnknown({ foo: 'bar' }), undefined);
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
  assert.equal(
    thinking.resolveConfiguredAnthropicThinkingBudgets({ anthropicThinkingBudgets: { high: 'not-a-number' } }),
    undefined
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
  assert.equal(protocolAudit.readProtocolMappingAuditBucket(audited, 'dropped').length, 1);
  assert.equal(protocolAudit.readProtocolMappingAuditBucket(audited, 'lossy').length, 1);
  const auditedNoMeta = {};
  audit.appendDroppedFieldAudit(auditedNoMeta, { field: 'x', targetProtocol: 'anthropic-messages', reason: 'drop' });
  assert.equal(protocolAudit.readProtocolMappingAuditBucket(auditedNoMeta, 'dropped').length, 1);
  const auditedPrimitiveMeta = { metadata: 'bad' };
  audit.appendLossyFieldAudit(auditedPrimitiveMeta, { field: 'y', targetProtocol: 'anthropic-messages', reason: 'loss' });
  assert.equal(protocolAudit.readProtocolMappingAuditBucket(auditedPrimitiveMeta, 'lossy').length, 1);
}

async function runGeminiHelperCoverage() {
  const antigravity = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/gemini-antigravity-request.js'));
  const systemSem = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/gemini-system-semantics.js'));
  const thinking = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/gemini-thinking-config.js'));
  const chatHelpers = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/gemini-chat-request-helpers.js'));
  const toolOutput = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/gemini-tool-output.js'));
  const audit = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/gemini-mapping-audit.js'));
  const protocolAudit = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/protocol-mapping-audit.js'));
  const state = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/gemini-semantics-state.js'));

  assert.equal(antigravity.stripOnlineSuffix('gemini-pro-online'), 'gemini-pro');
  assert.equal(antigravity.stripOnlineSuffix('gemini-pro'), 'gemini-pro');
  const reqNoTools = {};
  antigravity.injectGoogleSearchTool(reqNoTools);
  assert.deepEqual(reqNoTools.tools, [{ googleSearch: {} }]);
  const reqWithDecls = { tools: [{ functionDeclarations: [{ name: 'exec_command' }] }] };
  antigravity.injectGoogleSearchTool(reqWithDecls);
  assert.equal(reqWithDecls.tools.length, 1);
  const reqWithNoiseTools = { tools: [null, 1, { name: 'noop' }] };
  antigravity.injectGoogleSearchTool(reqWithNoiseTools);
  assert.equal(reqWithNoiseTools.tools.length, 4);
  const reqHasSearchTool = { tools: [{ googleSearch: {} }] };
  antigravity.injectGoogleSearchTool(reqHasSearchTool);
  assert.equal(reqHasSearchTool.tools.length, 1);
  const reqPrune = { tools: [{ functionDeclarations: [{ name: 'web_search' }, { name: 'exec_command' }] }, { functionDeclarations: [{ name: 'websearch' }] }] };
  antigravity.pruneSearchFunctionDeclarations(reqPrune);
  assert.equal(reqPrune.tools.length, 1);
  assert.equal(reqPrune.tools[0].functionDeclarations[0].name, 'exec_command');
  const reqPruneNoArray = {};
  antigravity.pruneSearchFunctionDeclarations(reqPruneNoArray);
  assert.equal(reqPruneNoArray.tools, undefined);
  const reqPruneKeepEmptyName = { tools: [{ functionDeclarations: [{ foo: 1 }] }] };
  antigravity.pruneSearchFunctionDeclarations(reqPruneKeepEmptyName);
  assert.equal(reqPruneKeepEmptyName.tools.length, 1);
  const reqPruneWithNoise = { tools: [1, { foo: 'bar' }, { functionDeclarations: [null, { name: 'web_search' }, { name: 'keep_me' }] }] };
  antigravity.pruneSearchFunctionDeclarations(reqPruneWithNoise);
  assert.equal(reqPruneWithNoise.tools.length >= 2, true);
  const undefNode = { a: '[undefined]', nested: { b: '[undefined]', ok: 1 }, arr: [{ c: '[undefined]' }] };
  antigravity.deepCleanUndefined(undefNode);
  assert.equal('a' in undefNode, false);
  assert.equal('b' in undefNode.nested, false);
  assert.equal('c' in undefNode.arr[0], false);
  antigravity.deepCleanUndefined('noop');
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
  const imageCfgMedium = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro-image-21x9-2k',
    mappedModel: 'gemini-3-pro-image'
  });
  assert.equal(imageCfgMedium.imageConfig.aspectRatio, '21:9');
  assert.equal(imageCfgMedium.imageConfig.imageSize, '2K');
  const imageCfgBadSize = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro-image-1x1',
    mappedModel: 'gemini-3-pro-image',
    size: 'bad'
  });
  assert.equal(imageCfgBadSize.imageConfig.aspectRatio, '1:1');
  const imageCfgHd = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro-image',
    mappedModel: 'gemini-3-pro-image',
    size: '1024x1024',
    quality: 'hd'
  });
  assert.equal(imageCfgHd.imageConfig.imageSize, '4K');
  const imageCfgMediumQ = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro-image',
    mappedModel: 'gemini-3-pro-image',
    size: '1024x1024',
    quality: 'medium'
  });
  assert.equal(imageCfgMediumQ.imageConfig.imageSize, '2K');
  const imageCfgTall = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro-image',
    mappedModel: 'gemini-3-pro-image',
    size: '1024x1792'
  });
  assert.equal(imageCfgTall.imageConfig.aspectRatio, '9:16');
  const imageCfgUltraWide = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro-image',
    mappedModel: 'gemini-3-pro-image',
    size: '2100x900'
  });
  assert.equal(imageCfgUltraWide.imageConfig.aspectRatio, '21:9');
  const imageCfgPortrait = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro-image',
    mappedModel: 'gemini-3-pro-image',
    size: '768x1024'
  });
  assert.equal(imageCfgPortrait.imageConfig.aspectRatio, '3:4');
  const imageCfgLandscape43 = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro-image',
    mappedModel: 'gemini-3-pro-image',
    size: '1024x768'
  });
  assert.equal(imageCfgLandscape43.imageConfig.aspectRatio, '4:3');
  const imageCfgModelTag43 = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro-image-4x3',
    mappedModel: 'gemini-3-pro-image'
  });
  assert.equal(imageCfgModelTag43.imageConfig.aspectRatio, '4:3');
  const imageCfgModelTag916 = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro-image-9x16',
    mappedModel: 'gemini-3-pro-image'
  });
  assert.equal(imageCfgModelTag916.imageConfig.aspectRatio, '9:16');
  const imageCfgModelTag34 = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro-image-3x4',
    mappedModel: 'gemini-3-pro-image'
  });
  assert.equal(imageCfgModelTag34.imageConfig.aspectRatio, '3:4');
  const imageCfgModelTag11 = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro-image-1-1',
    mappedModel: 'gemini-3-pro-image'
  });
  assert.equal(imageCfgModelTag11.imageConfig.aspectRatio, '1:1');
  const imageCfgZeroWidth = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro-image',
    mappedModel: 'gemini-3-pro-image',
    size: '0x100'
  });
  assert.equal(imageCfgZeroWidth.imageConfig.aspectRatio, '1:1');
  const webByBuiltinSearch = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro',
    mappedModel: 'gemini-3-pro',
    tools: [{ googleSearchRetrieval: {} }]
  });
  assert.equal(webByBuiltinSearch.requestType, 'web_search');
  const webByType = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro',
    mappedModel: 'gemini-3-pro',
    tools: [{ type: 'web_search' }]
  });
  assert.equal(webByType.requestType, 'web_search');
  const webByFnDecl = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro',
    mappedModel: 'gemini-3-pro',
    tools: [{ functionDeclarations: [{ name: 'websearch' }] }]
  });
  assert.equal(webByFnDecl.requestType, 'web_search');
  const webByFnName = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro',
    mappedModel: 'gemini-3-pro',
    tools: [{ function: { name: 'google_search' } }]
  });
  assert.equal(webByFnName.requestType, 'web_search');
  const agentByEmptyToolName = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro',
    mappedModel: 'gemini-3-pro',
    tools: [{ name: '   ' }]
  });
  assert.equal(agentByEmptyToolName.requestType, 'agent');
  const imagePreviewAlias = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-pro-image-preview',
    mappedModel: 'gemini-3-pro-image-preview'
  });
  assert.equal(imagePreviewAlias.finalModel, 'gemini-3-pro-image');
  const flashPreviewAlias = antigravity.resolveAntigravityRequestConfig({
    originalModel: 'gemini-3-flash-preview',
    mappedModel: 'gemini-3-flash-preview'
  });
  assert.equal(flashPreviewAlias.finalModel, 'gemini-3-flash');

  const gemChat = {};
  assert.equal(typeof systemSem.ensureSystemSemantics(gemChat), 'object');
  assert.equal(typeof systemSem.ensureSystemSemantics({ semantics: 'bad' }), 'object');
  gemChat.semantics.system.textBlocks = ['a', '', 1, 'b'];
  assert.deepEqual(systemSem.readSystemTextBlocksFromSemantics(gemChat), ['a', 'b']);
  assert.equal(systemSem.readSystemTextBlocksFromSemantics({ semantics: { system: { textBlocks: 'bad' } } }), undefined);
  assert.deepEqual(systemSem.collectSystemSegments({ parts: [{ text: 'sys1' }, { parts: [{ text: 'sys2' }] }] }), ['sys1\nsys2']);
  assert.deepEqual(systemSem.collectSystemSegments(['a', ['b'], { text: 'c' }]), ['a\nb\nc']);
  assert.deepEqual(systemSem.collectSystemSegments({ foo: 'bar' }), []);
  const req1 = {};
  systemSem.applyGeminiRequestSystemInstruction({ request: req1, isAntigravityProvider: false, semanticsSystemInstruction: { parts: [{ text: 'x' }] } });
  assert.equal(req1.systemInstruction.parts[0].text, 'x');
  const req2 = {};
  systemSem.applyGeminiRequestSystemInstruction({ request: req2, isAntigravityProvider: false, protocolStateSystemInstruction: { parts: [{ text: 'y' }] } });
  assert.equal(req2.systemInstruction.parts[0].text, 'y');
  const req3 = {};
  systemSem.applyGeminiRequestSystemInstruction({ request: req3, isAntigravityProvider: false, systemTextBlocksFromSemantics: ['a', 'b'] });
  assert.equal(req3.systemInstruction.parts.length, 2);
  const req3NoOp = {};
  systemSem.applyGeminiRequestSystemInstruction({ request: req3NoOp, isAntigravityProvider: false, systemTextBlocksFromSemantics: ['   ', '', 1] });
  assert.equal(req3NoOp.systemInstruction, undefined);
  const req4 = {};
  systemSem.applyGeminiRequestSystemInstruction({ request: req4, isAntigravityProvider: true, semanticsSystemInstruction: 'extra', protocolStateSystemInstruction: 'extra', systemTextBlocksFromSemantics: ['extra', 'more'] });
  assert.match(req4.systemInstruction.parts[0].text, /Antigravity/);
  assert.equal(req4.systemInstruction.parts.length, 2);
  const req5 = {};
  systemSem.applyGeminiRequestSystemInstruction({ request: req5, isAntigravityProvider: true });
  assert.match(req5.systemInstruction.parts[0].text, /Antigravity/);
  const req6 = {};
  systemSem.applyGeminiRequestSystemInstruction({ request: req6, isAntigravityProvider: true, systemTextBlocksFromSemantics: ['   ', '', 1] });
  assert.match(req6.systemInstruction.parts[0].text, /Antigravity/);

  assert.equal(thinking.buildGenerationConfigFromParameters({ temperature: 0.1 }).temperature, 0.1);
  assert.equal(thinking.buildGenerationConfigFromParameters({ max_tokens: 88 }).maxOutputTokens, 88);
  assert.deepEqual(thinking.buildGenerationConfigFromParameters({ reasoning: false }).thinkingConfig, { includeThoughts: false, thinkingBudget: 0 });
  assert.equal(thinking.buildGenerationConfigFromParameters({ reasoning: 'high' }).thinkingConfig.thinkingBudget, 8192);
  assert.deepEqual(thinking.buildGenerationConfigFromParameters({ reasoning: 'off' }).thinkingConfig, { includeThoughts: false, thinkingBudget: 0 });
  assert.equal(thinking.buildGenerationConfigFromParameters({ reasoning: 'weird' }).thinkingConfig.includeThoughts, true);
  assert.equal(thinking.buildGenerationConfigFromParameters({ reasoning: 2048 }).thinkingConfig.thinkingBudget, 2048);
  assert.deepEqual(thinking.buildGenerationConfigFromParameters({ reasoning: 0 }).thinkingConfig, { includeThoughts: false, thinkingBudget: 0 });
  assert.deepEqual(thinking.buildGenerationConfigFromParameters({ reasoning: { enabled: false } }).thinkingConfig, { includeThoughts: false, thinkingBudget: 0 });
  assert.equal(thinking.buildGenerationConfigFromParameters({ reasoning: { budget_tokens: 1234 } }).thinkingConfig.thinkingBudget, 1234);
  assert.deepEqual(thinking.buildGenerationConfigFromParameters({ reasoning: { budget_tokens: 0 } }).thinkingConfig, { includeThoughts: false, thinkingBudget: 0 });
  assert.deepEqual(thinking.buildGenerationConfigFromParameters({ reasoning: { effort: 'disabled' } }).thinkingConfig, { includeThoughts: false, thinkingBudget: 0 });
  assert.equal(thinking.buildGenerationConfigFromParameters({ reasoning: { effort: 'medium' } }).thinkingConfig.thinkingBudget, 4096);
  assert.equal(thinking.buildGenerationConfigFromParameters({ reasoning: { level: 'high' } }).thinkingConfig.thinkingBudget, 8192);
  assert.equal(thinking.buildGenerationConfigFromParameters({ reasoning: { budget: 256 } }).thinkingConfig.thinkingBudget, 256);
  assert.equal(thinking.buildGenerationConfigFromParameters({ reasoning: { max_tokens: 512 } }).thinkingConfig.thinkingBudget, 512);
  assert.equal(thinking.buildGenerationConfigFromParameters({ reasoning: { enabled: true } }).thinkingConfig.includeThoughts, true);
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
  const proReq = {};
  thinking.applyAntigravityThinkingConfig(proReq, 'gemini-pro');
  assert.equal(proReq.generationConfig.thinkingConfig.thinkingBudget, 1024);
  const disabledBudgetReq = { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } };
  thinking.applyAntigravityThinkingConfig(disabledBudgetReq, 'gemini-pro');
  assert.equal(disabledBudgetReq.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(disabledBudgetReq.generationConfig.thinkingConfig.includeThoughts, undefined);
  const flashNonObjReq = { generationConfig: { thinkingConfig: 'bad' } };
  thinking.applyAntigravityThinkingConfig(flashNonObjReq, 'gemini-3-flash');
  assert.equal(flashNonObjReq.generationConfig.thinkingConfig.includeThoughts, true);
  const claudeSnakeCaseToolReq = { generationConfig: {}, contents: [{ parts: [{ function_call: { name: 'x' } }] }] };
  thinking.applyAntigravityThinkingConfig(claudeSnakeCaseToolReq, 'claude-sonnet-thinking');
  assert.equal(claudeSnakeCaseToolReq.generationConfig.thinkingConfig, undefined);

  const defs = chatHelpers.buildToolSchemaKeyMap([
    { function: { name: 'exec_command', parameters: { properties: { cmd: {}, workdir: {} } } } },
    { function: { name: 'apply_patch', parameters: { properties: { instructions: {}, patch: {} } } } },
    { name: 'ignored', parameters: null }
  ]);
  assert.equal(defs.get('exec_command').has('cmd'), true);
  const defsFallback = chatHelpers.buildToolSchemaKeyMap([{ name: 'fallback_tool', parameters: { properties: { x: {} } } }]);
  assert.equal(defsFallback.get('fallback_tool').has('x'), true);
  const defsFallbackFromInvalidFnName = chatHelpers.buildToolSchemaKeyMap([
    { name: 'fallback_from_name', function: { name: 1 }, parameters: { properties: { y: {} } } }
  ]);
  assert.equal(defsFallbackFromInvalidFnName.get('fallback_from_name').has('y'), true);
  assert.equal(chatHelpers.buildToolSchemaKeyMap([{ function: { name: 'noprops', parameters: { type: 'object' } } }]).size, 0);
  assert.equal(chatHelpers.buildToolSchemaKeyMap([{ function: { name: 'emptyprops', parameters: { properties: {} } } }]).size, 0);
  assert.equal(chatHelpers.buildToolSchemaKeyMap([{ function: { name: ' ', parameters: { properties: { x: {} } } } }]).size, 0);
  assert.deepEqual(chatHelpers.alignToolCallArgsToSchema({ toolName: 'exec_command', args: { command: 'ls', noise: 1 }, schemaKeys: defs }), { cmd: 'ls' });
  assert.deepEqual(chatHelpers.alignToolCallArgsToSchema({ toolName: 'exec_command', args: { cmd: 'ls' }, schemaKeys: new Map([['exec_command', new Set(['command'])]]) }), { command: 'ls' });
  assert.deepEqual(chatHelpers.alignToolCallArgsToSchema({ toolName: 'write_stdin', args: { text: 'hi' }, schemaKeys: new Map([['write_stdin', new Set(['chars'])]]) }), { chars: 'hi' });
  assert.deepEqual(chatHelpers.alignToolCallArgsToSchema({ toolName: 'write_stdin', args: { chars: 'hi' }, schemaKeys: new Map([['write_stdin', new Set(['text'])]]) }), { text: 'hi' });
  assert.deepEqual(chatHelpers.alignToolCallArgsToSchema({ toolName: 'apply_patch', args: { input: 'patch-body' }, schemaKeys: defs }), { instructions: 'patch-body', patch: 'patch-body' });
  assert.deepEqual(chatHelpers.alignToolCallArgsToSchema({ toolName: 'apply_patch', args: { patch: 'patch-body' }, schemaKeys: defs }), { instructions: 'patch-body', patch: 'patch-body' });
  assert.deepEqual(
    chatHelpers.alignToolCallArgsToSchema({ toolName: 'apply_patch', args: { input: '   ' }, schemaKeys: defs }),
    {}
  );
  assert.deepEqual(chatHelpers.alignToolCallArgsToSchema({ toolName: '', args: { x: 1 }, schemaKeys: defs }), { x: 1 });
  assert.deepEqual(chatHelpers.alignToolCallArgsToSchema({ toolName: 1, args: { x: 1 }, schemaKeys: defs }), { x: 1 });
  assert.deepEqual(chatHelpers.alignToolCallArgsToSchema({ toolName: 'custom_tool', args: { x: 1 }, schemaKeys: new Map([['custom_tool', new Set(['x'])]]) }), { x: 1 });
  assert.equal(chatHelpers.mapChatRoleToGemini('assistant'), 'model');
  assert.equal(chatHelpers.mapToolNameForGemini('web_search_20250305'), 'websearch');
  assert.equal(chatHelpers.mapToolNameForGemini('   '), undefined);
  assert.deepEqual([...chatHelpers.collectAssistantToolCallIds([{ role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'x' } }] }, { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'x' } }, { id: 'b', function: { name: 'y' } }] }])].sort(), ['a', 'b']);
  assert.equal(chatHelpers.collectAssistantToolCallIds([{ role: 'assistant', tool_calls: 'bad-shape' }, { role: 'assistant', tool_calls: [{ id: 1 }] }]).size, 0);
  assert.equal(chatHelpers.isResponsesOrigin({ semantics: { responses: {} } }), true);
  assert.equal(chatHelpers.isResponsesOrigin({ metadata: { context: { providerProtocol: 'openai-responses' } } }), true);
  assert.equal(chatHelpers.isResponsesOrigin({ metadata: { context: { entryEndpoint: '/v1/responses' } } }), true);
  assert.equal(chatHelpers.isResponsesOrigin({ metadata: { context: { entryEndpoint: '/v1/chat/completions' } } }), false);
  const gemParams = chatHelpers.collectParameters({ model: 'gemini-pro', generationConfig: { temperature: 0.2, topK: 40 }, toolConfig: { functionCallingConfig: {} }, metadata: { __rcc_stream: 1 } });
  assert.equal(gemParams.model, 'gemini-pro');
  assert.equal(gemParams.top_k, 40);
  assert.equal(gemParams.stream, true);
  assert.equal(chatHelpers.collectParameters({ metadata: {} }), undefined);
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
  const parts2 = [];
  chatHelpers.appendChatContentToGeminiParts({ role: 'user', content: { text: 'ignored-object' } }, parts2, {});
  assert.equal(parts2.length, 0);
  const parts3 = [];
  chatHelpers.appendChatContentToGeminiParts({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/z.png' } }, { type: 'image', data: 'abc' }, { type: 'other', foo: 1 }] }, parts3, {});
  assert.equal(parts3.some((p) => p.text === 'https://example.com/z.png'), true);
  assert.equal(parts3.some((p) => p.text === 'abc'), true);
  assert.equal(parts3.some((p) => typeof p.text === 'string' && p.text.includes('foo')), true);
  const partsUri = [];
  chatHelpers.appendChatContentToGeminiParts({ role: 'user', content: [{ type: 'image', uri: 'https://example.com/from-uri.png' }] }, partsUri, {});
  assert.equal(partsUri.some((p) => p.text === 'https://example.com/from-uri.png'), true);
  const partsNullish = [];
  chatHelpers.appendChatContentToGeminiParts({ role: 'user', content: [null, undefined, '', { type: 'image', url: '   ' }] }, partsNullish, {});
  assert.equal(partsNullish.some((p) => p.text === '[image]'), true);
  const partsDataUrlEdge = [];
  chatHelpers.appendChatContentToGeminiParts(
    {
      role: 'user',
      content: [
        { type: 'image', image_url: 'data:;base64,abc' },
        { type: 'image', image_url: 'data:image/png;base64,   ' },
        { type: 'text' },
        0
      ]
    },
    partsDataUrlEdge,
    {}
  );
  assert.equal(partsDataUrlEdge.some((p) => p.inlineData?.data === 'abc'), true);
  assert.equal(partsDataUrlEdge.some((p) => typeof p.text === 'string' && p.text.startsWith('data:image/png;base64')), true);
  const parts4 = [];
  chatHelpers.appendChatContentToGeminiParts({ role: 'user', content: [{ type: 'text', content: 'from-content' }, { type: 'text', text: 'from-text' }] }, parts4, {});
  assert.equal(parts4.some((p) => p.text === 'from-content'), true);
  assert.equal(parts4.some((p) => p.text === 'from-text'), true);

  const missing = [];
  const outputs = toolOutput.normalizeToolOutputs([
    { role: 'tool', tool_call_id: 'tool-1', content: { ok: true }, name: 'apply_patch' },
    { role: 'tool', content: 'oops' }
  ], missing);
  assert.equal(outputs.length, 1);
  assert.equal(missing.length, 1);
  assert.deepEqual(toolOutput.synthesizeToolOutputsFromMessages(undefined), []);
  assert.deepEqual(toolOutput.synthesizeToolOutputsFromMessages([{ role: 'assistant', content: 'no-tool-calls' }]), []);
  assert.equal(toolOutput.synthesizeToolOutputsFromMessages([{ role: 'assistant', tool_calls: [{ id: 'x', function: { name: 'fn' } }, { id: 'x', function: { name: 'fn' } }] }]).length, 1);
  assert.equal(toolOutput.synthesizeToolOutputsFromMessages([{ role: 'assistant', tool_calls: [{ function: { name: 'fn' } }] }]).length, 0);
  const circ2 = {}; circ2.self = circ2;
  assert.match(toolOutput.normalizeToolContent(circ2), /\[object Object\]|self/);
  assert.equal(toolOutput.convertToolMessageToOutput({ id: 'x', content: 'ok' }, new Set(['y'])), null);
  assert.equal(toolOutput.convertToolMessageToOutput({ id: 'x', content: 'ok' }, new Set(['x'])).tool_call_id, 'x');
  assert.equal(toolOutput.convertToolMessageToOutput({ tool_call_id: 'tc-x', content: 'ok' }, new Set(['tc-x'])).tool_call_id, 'tc-x');
  assert.equal(toolOutput.convertToolMessageToOutput({ content: 'ok' }, new Set(['x'])), null);
  assert.equal(toolOutput.sanitizeAntigravityToolCallId('  bad id!*  '), 'bad_id');
  assert.equal(toolOutput.sanitizeAntigravityToolCallId('clean_id'), 'clean_id');
  assert.equal(toolOutput.sanitizeAntigravityToolCallId('   '), '');
  assert.equal(toolOutput.sanitizeAntigravityToolCallId('!!!').startsWith('call_'), true);
  assert.equal(toolOutput.sanitizeAntigravityToolCallId(123), '');
  const cloned = toolOutput.cloneAsJsonValue({ big: 1n, nested: [1, 'x'] });
  assert.equal(cloned.big, '1');
  assert.equal(toolOutput.cloneAsJsonValue(5), 5);
  assert.deepEqual(toolOutput.cloneAsJsonValue([1, { x: 2 }]), [1, { x: 2 }]);
  const originalJsonStringify = JSON.stringify;
  JSON.stringify = () => { throw new Error('forced stringify error'); };
  try {
    assert.equal(toolOutput.cloneAsJsonValue(7), 7);
    assert.deepEqual(toolOutput.cloneAsJsonValue([1, { x: 2 }]), [1, { x: 2 }]);
  } finally {
    JSON.stringify = originalJsonStringify;
  }
  const originalJsonStringifyForNormalize = JSON.stringify;
  JSON.stringify = () => { throw new Error('forced normalizeToolContent error'); };
  try {
    assert.equal(toolOutput.normalizeToolContent({ force: 'throw' }), '[object Object]');
  } finally {
    JSON.stringify = originalJsonStringifyForNormalize;
  }
  const fr1 = toolOutput.buildFunctionResponseEntry({ tool_call_id: 'bad id!*', content: '[1,2]', name: 'toolA' }, { includeCallId: true });
  assert.equal(fr1.parts[0].functionResponse.id, 'bad_id');
  const fr2 = toolOutput.buildFunctionResponseEntry({ tool_call_id: 't2', content: 'not-json', name: 'toolB' });
  assert.equal(fr2.parts[0].functionResponse.response.result, 'not-json');
  const fr3 = toolOutput.buildFunctionResponseEntry({ tool_call_id: 't3', content: '{"ok":true}', name: 'toolC' });
  assert.equal(fr3.parts[0].functionResponse.response.ok, true);
  const fr4 = toolOutput.buildFunctionResponseEntry({ tool_call_id: 't4', content: undefined, name: '' });
  assert.equal(fr4.parts[0].functionResponse.name, 'tool');
  assert.equal(fr4.parts[0].functionResponse.response.result, null);

  const auditChat = { metadata: {} };
  audit.appendDroppedFieldAudit(auditChat, { field: 'x', targetProtocol: 'gemini-chat', reason: 'drop' });
  audit.appendDroppedFieldAudit(auditChat, { field: 'x', targetProtocol: 'gemini-chat', reason: 'drop' });
  audit.appendLossyFieldAudit(auditChat, { field: 'y', targetProtocol: 'gemini-chat', reason: 'loss' });
  assert.equal(protocolAudit.readProtocolMappingAuditBucket(auditChat, 'dropped').length, 1);
  assert.equal(protocolAudit.readProtocolMappingAuditBucket(auditChat, 'lossy').length, 1);

  const gemStateChat = {};
  assert.equal(typeof state.ensureGeminiSemanticsNode(gemStateChat), 'object');
  assert.equal(typeof state.ensureGeminiSemanticsNode({ semantics: { gemini: { ok: true } } }), 'object');
  state.markGeminiExplicitEmptyTools({});
  state.markGeminiExplicitEmptyTools({ semantics: { tools: { existing: true } } });
  state.markGeminiExplicitEmptyTools(gemStateChat);
  assert.equal(state.hasExplicitEmptyToolsSemantics(gemStateChat), true);
  assert.equal(state.readGeminiSemantics(gemStateChat) !== undefined, true);
  assert.equal(state.readGeminiSemantics({}), undefined);
  assert.equal(state.hasExplicitEmptyToolsSemantics({ semantics: { tools: 'bad' } }), false);
}

async function runResponsesSubmitCoverage() {
  const submit = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/responses-submit-tool-outputs.js'));

  assert.equal(submit.isSubmitToolOutputsEndpoint({ entryEndpoint: '/v1/responses.submit_tool_outputs' }), true);
  assert.equal(submit.isSubmitToolOutputsEndpoint({ entryEndpoint: '/v1/responses' }), false);
  assert.equal(submit.isSubmitToolOutputsEndpoint(undefined), false);
  assert.equal(submit.isSubmitToolOutputsEndpoint({ entryEndpoint: 1 }), false);
  assert.equal(submit.deriveResumeToolOutputsFromResume('bad'), undefined);
  assert.equal(submit.readResponsesResumeFromSemantics(undefined), undefined);
  assert.equal(submit.readResponsesResumeFromSemantics({ semantics: { responses: 'bad' } }), undefined);
  assert.equal(submit.readResponsesResumeFromSemantics({ semantics: { responses: { resume: 'bad' } } }), undefined);
  assert.deepEqual(submit.readResponsesResumeFromSemantics({ semantics: { responses: { resume: { ok: 1 } } } }), { ok: 1 });
  assert.deepEqual(submit.extractCapturedToolOutputs(undefined), []);
  assert.deepEqual(submit.extractCapturedToolOutputs({ __captured_tool_results: [] }), []);
  const extractedCaptured = submit.extractCapturedToolOutputs({
    __captured_tool_results: [null, { output: 'missing-id' }, { tool_call_id: 'tc-1', output: 'ok' }, { call_id: 'cid-1', output: { ok: true }, name: 'named' }]
  });
  assert.equal(extractedCaptured.length, 2);
  assert.equal(extractedCaptured[0].tool_call_id, 'tc-1');
  assert.equal(extractedCaptured[1].tool_call_id, 'cid-1');

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

  const throwingResponses = {};
  Object.defineProperty(throwingResponses, 'resume', {
    get() {
      throw new Error('resume-read-failed');
    }
  });
  const payload4 = submit.buildSubmitToolOutputsPayload(
    {
      messages: [{ role: 'user', content: 'hi' }],
      parameters: {},
      toolOutputs: [{ content: { ok: true } }, { content: 'dup', tool_call_id: 'submit_tool_1' }],
      semantics: { responses: throwingResponses }
    },
    { entryEndpoint: '/v1/responses.submit_tool_outputs' },
    { previous_response_id: 'resp-catch' }
  );
  assert.equal(payload4.response_id, 'resp-catch');
  assert.equal(payload4.tool_outputs.length, 1);
  assert.equal(payload4.tool_outputs[0].tool_call_id, 'submit_tool_1');
  assert.equal(payload4.model, undefined);

  const payload5 = submit.buildSubmitToolOutputsPayload(
    {
      messages: [{ role: 'user', content: 'hi' }],
      parameters: {},
      semantics: {
        responses: {
          resume: {
            restoredFromResponseId: 'resp-invalid-context',
            toolOutputsDetailed: [{ callId: 'resume-invalid-1', outputText: 'resume-fallback' }]
          }
        }
      }
    },
    { entryEndpoint: '/v1/responses.submit_tool_outputs' },
    'bad-context'
  );
  assert.equal(payload5.response_id, 'resp-invalid-context');
  assert.equal(payload5.tool_outputs[0].tool_call_id, 'resume-invalid-1');

  const payload6 = submit.buildSubmitToolOutputsPayload(
    {
      messages: [{ role: 'user', content: 'hi' }],
      parameters: {}
    },
    { entryEndpoint: '/v1/responses.submit_tool_outputs' },
    {
      previous_response_id: 'resp-snapshot',
      __captured_tool_results: [null, { output: 'missing-id' }, { call_id: 'snap-1', output: 'ok', name: 'cap' }]
    }
  );
  assert.equal(payload6.response_id, 'resp-snapshot');
  assert.equal(payload6.tool_outputs.length, 1);
  assert.equal(payload6.tool_outputs[0].tool_call_id, 'snap-1');

  const payload7 = submit.buildSubmitToolOutputsPayload(
    {
      messages: [{ role: 'user', content: 'hi' }],
      parameters: {},
      toolOutputs: [{ tool_call_id: 'null-1', content: null }],
      semantics: { responses: 'bad-node' }
    },
    { entryEndpoint: '/v1/responses.submit_tool_outputs' },
    { previous_response_id: 'resp-null-output' }
  );
  assert.equal(payload7.response_id, 'resp-null-output');
  assert.equal(payload7.tool_outputs[0].output, '');

  const circularOutput = {};
  circularOutput.self = circularOutput;
  const payload8 = submit.buildSubmitToolOutputsPayload(
    {
      messages: [{ role: 'user', content: 'hi' }],
      parameters: {},
      toolOutputs: [{ tool_call_id: 'circ-1', content: circularOutput }]
    },
    { entryEndpoint: '/v1/responses.submit_tool_outputs' },
    { previous_response_id: 'resp-circular-output' }
  );
  assert.equal(payload8.response_id, 'resp-circular-output');
  assert.match(payload8.tool_outputs[0].output, /\[object Object\]/);

  assert.throws(
    () => submit.buildSubmitToolOutputsPayload({ messages: [], parameters: {}, semantics: { responses: { context: {} } } }, { entryEndpoint: '/v1/responses.submit_tool_outputs' }, {}),
    /response_id/
  );
  assert.throws(
    () => submit.buildSubmitToolOutputsPayload(
      { messages: [], parameters: {}, semantics: { responses: { resume: { restoredFromResponseId: 'resp-empty' } } } },
      { entryEndpoint: '/v1/responses.submit_tool_outputs' },
      {}
    ),
    /at least one tool output entry/
  );
}

async function runResponsesMainCoverage() {
  const {
    ResponsesSemanticMapper,
    attachResponsesSemantics,
    mapToolOutputs,
    normalizeMessages,
    normalizeTools,
    serializeSystemContent
  } = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/responses-mapper.js'));
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
        tool_outputs: [123, { output: 'missing-id' }, { id: 'tool-1', output: { ok: true }, name: 'apply_patch' }, { id: 'tool-2', output: 'plain-text' }],
        tools: [123],
        metadata: { source: 'coverage' },
        stream: true
      }
    },
    ctx
  );
  assert.equal(inbound.messages.length, 1);
  assert.equal(inbound.messages[0].content, 'oops');
  assert.equal(inbound.toolOutputs?.length, 2);
  assert.equal(inbound.toolOutputs?.[0]?.tool_call_id, 'tool-1');
  assert.equal(inbound.metadata?.missingFields?.length, 2);
  assert.equal(typeof inbound.semantics?.responses, 'object');

  const inboundUnknownRequestId = await mapper.toChat(
    {
      protocol: 'openai-responses',
      direction: 'request',
      payload: {
        model: 'gpt-4o-mini',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'fallback' }] }]
      }
    },
    {
      providerProtocol: 'openai-responses',
      entryEndpoint: '/v1/responses',
      requestId: '   '
    }
  );
  assert.equal(Array.isArray(inboundUnknownRequestId.messages), true);
  assert.equal(inboundUnknownRequestId.messages.length > 0, true);

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

  const outboundSemanticsOnly = await mapper.fromChat(
    {
      messages: [{ role: 'user', content: 'only-semantics' }],
      parameters: { model: 'gpt-4o-mini' },
      metadata: 'bad-shape',
      semantics: {
        responses: {
          context: {
            metadata: { semanticsOnly: 1 }
          }
        }
      }
    },
    ctx
  );
  assert.equal(outboundSemanticsOnly.payload.metadata.semanticsOnly, 1);

  const attachedExisting = { keep: true };
  assert.equal(attachResponsesSemantics(attachedExisting, undefined, undefined), attachedExisting);
  assert.deepEqual(
    attachResponsesSemantics({ responses: { context: { a: 1 } } }, undefined, { restoredFromResponseId: 'resp-r' }),
    {
      responses: {
        context: { a: 1 },
        resume: { restoredFromResponseId: 'resp-r' }
      }
    }
  );
  const helperMissing = [];
  assert.deepEqual(normalizeMessages(undefined, helperMissing), []);
  assert.equal(helperMissing[0].reason, 'absent');
  const helperInvalidType = [];
  assert.deepEqual(normalizeMessages('bad', helperInvalidType), []);
  assert.equal(helperInvalidType[0].reason, 'invalid_type');
  const helperInvalidEntry = [];
  assert.equal(normalizeMessages([{ role: 'user', content: 'ok' }, 5], helperInvalidEntry).length, 1);
  assert.equal(helperInvalidEntry[0].reason, 'invalid_entry');
  const helperInvalidTools = [];
  assert.equal(normalizeTools([123, 'bad'], helperInvalidTools), undefined);
  assert.equal(helperInvalidTools.length, 2);
  const circularMapOutput = {};
  circularMapOutput.self = circularMapOutput;
  const mappedOutputs = mapToolOutputs(
    [{ id: 'circ-map-1', output: circularMapOutput }, { id: 'text-map-1', output: 'plain-text' }],
    []
  );
  assert.match(mappedOutputs[0].content, /\[object Object\]/);
  assert.equal(mappedOutputs[1].content, 'plain-text');
  assert.equal(serializeSystemContent(undefined), undefined);
  assert.equal(serializeSystemContent({ role: 'system', content: null }), undefined);
  assert.equal(serializeSystemContent({ role: 'system', content: { nested: true } }), '{"nested":true}');
  const circularSystem = {};
  circularSystem.self = circularSystem;
  assert.match(serializeSystemContent({ role: 'system', content: circularSystem }), /\[object Object\]/);

  const submitOutbound = await mapper.fromChat(
    {
      messages: [{ role: 'user', content: 'submit' }],
      parameters: { model: 'gpt-4o-mini' },
      toolOutputs: [{ content: { ok: true } }],
      metadata: { context: ctx, submitEnvelope: 1 },
      semantics: {
        responses: {
          context: 'bad-shape',
          resume: { restoredFromResponseId: 'resp-submit' }
        }
      }
    },
    {
      ...ctx,
      entryEndpoint: '/v1/responses.submit_tool_outputs'
    }
  );
  assert.equal(submitOutbound.meta.submitToolOutputs, true);
  assert.equal(submitOutbound.payload.response_id, 'resp-submit');
  assert.equal(submitOutbound.payload.tool_outputs[0].tool_call_id, 'submit_tool_1');

  const outboundExistingSystems = await mapper.fromChat(
    {
      messages: [{ role: 'user', content: 'u2' }],
      parameters: { model: 'gpt-4o-mini' },
      semantics: {
        responses: {
          context: {
            originalSystemMessages: ['preserved-system'],
            metadata: { kept: true }
          }
        }
      }
    },
    {
      providerProtocol: 'openai-responses',
      entryEndpoint: '/v1/responses',
      requestId: '   '
    }
  );
  assert.equal(outboundExistingSystems.payload.instructions, undefined);
  assert.equal(outboundExistingSystems.payload.metadata.kept, true);

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
  const {
    AnthropicSemanticMapper,
    sanitizeAnthropicPayload
  } = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/anthropic-mapper.js'));
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

  const sanitized = sanitizeAnthropicPayload({
    model: 'claude-sanitize',
    messages: [],
    metadata: { ok: true },
    __anthropicMirror: { shouldDrop: true },
    unknown_field: 1
  });
  assert.equal(sanitized.model, 'claude-sanitize');
  assert.equal(Array.isArray(sanitized.messages), true);
  assert.equal(sanitized.metadata.ok, true);
  assert.equal('__anthropicMirror' in sanitized, false);
  assert.equal('unknown_field' in sanitized, false);

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
  const {
    GeminiSemanticMapper,
    buildGeminiRequestFromChat
  } = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/gemini-mapper.js'));
  const protocolAudit = await import(moduleUrl('conversion/hub/operation-table/semantic-mappers/protocol-mapping-audit.js'));
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
  const inboundMissing = await mapper.toChat(
    {
      protocol: 'gemini-chat',
      direction: 'request',
      payload: {
        metadata: {
          rcc_passthrough_tool_choice: '"none"',
          __rcc_raw_system: { legacy: true }
        }
      }
    },
    {}
  );
  assert.equal(Array.isArray(inboundMissing.metadata?.missingFields), true);
  assert.equal(inboundMissing.metadata?.providerMetadata?.__rcc_raw_system, undefined);
  assert.equal(inboundMissing.parameters?.tool_choice, 'none');

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
  const unknownReqId = await mapper.fromChat(
    {
      messages: [{ role: 'user', content: 'unknown-request-id' }],
      parameters: { model: 'models/gemini-pro' }
    },
    {}
  );
  assert.equal(unknownReqId.payload.model, 'models/gemini-pro');

  const builtMain = buildGeminiRequestFromChat(
    {
      messages: [
        {
          role: 'assistant',
          content: 'done',
          tool_calls: [{ id: 'call-1', function: { name: 'exec_command', arguments: '[1,2]' } }]
        },
        { role: 'user', content: 'hello' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            description: 'run command',
            parameters: {
              type: 'object',
              properties: {
                cmd: { type: 'string' }
              },
              required: ['cmd']
            }
          }
        }
      ],
      parameters: {
        model: 'models/gemini-pro',
        reasoning: 'medium',
        prompt_cache_key: 'pc',
        response_format: { type: 'json_object' },
        parallel_tool_calls: true,
        service_tier: 'auto',
        truncation: 'auto',
        include: ['reasoning'],
        store: true,
        stream: false,
        tool_choice: 'auto'
      },
      semantics: {
        responses: {},
        gemini: {
          generationConfig: { topK: 33 },
          safetySettings: [{ category: 'X', threshold: 'Y' }],
          toolConfig: { functionCallingConfig: { mode: 'ANY' } },
          providerMetadata: { sem: 'yes' }
        },
        tools: { explicitEmpty: true }
      },
      metadata: {
        context: ctx
      }
    },
    { context: ctx }
  );
  assert.equal(builtMain.tools[0].functionDeclarations[0].name, 'exec_command');
  assert.deepEqual(builtMain.contents[0].parts[1].functionCall.args, { value: [1, 2] });
  assert.equal(builtMain.contents[2].parts[0].functionResponse.name, 'exec_command');
  assert.equal(builtMain.generationConfig.topK, 33);
  assert.equal(builtMain.generationConfig.thinkingConfig.thinkingBudget, 4096);
  assert.equal(builtMain.safetySettings[0].category, 'X');
  assert.equal(builtMain.toolConfig.functionCallingConfig.mode, 'ANY');
  assert.equal(builtMain.metadata.sem, 'yes');
  assert.equal(builtMain.metadata.__rcc_stream, false);
  assert.equal(builtMain.metadata.__rcc_tools_field_present, undefined);
  assert.equal(typeof builtMain.metadata.rcc_passthrough_tool_choice, 'string');

  const builtMainAuditChat = {
    metadata: {},
    parameters: {
      prompt_cache_key: 'pc',
      response_format: { type: 'json_object' },
      parallel_tool_calls: true,
      service_tier: 'auto',
      truncation: 'auto',
      include: ['reasoning'],
      store: true,
      reasoning: 'medium'
    }
  };
  buildGeminiRequestFromChat(
    {
      messages: [{ role: 'user', content: 'audit' }],
      parameters: { model: 'models/gemini-pro', ...builtMainAuditChat.parameters },
      semantics: { responses: {} },
      metadata: builtMainAuditChat.metadata
    },
    builtMainAuditChat.metadata
  );
  assert.equal(protocolAudit.readProtocolMappingAuditBucket(builtMainAuditChat, 'dropped').length, 6);
  assert.equal(protocolAudit.readProtocolMappingAuditBucket(builtMainAuditChat, 'unsupported').length, 1);
  assert.equal(protocolAudit.readProtocolMappingAuditBucket(builtMainAuditChat, 'lossy').length, 1);

  const builtMetadataFallback = buildGeminiRequestFromChat(
    {
      messages: [{ role: 'user', content: 'meta-fallback' }],
      parameters: {
        model: 'models/gemini-pro',
        tool_config: { functionCallingConfig: { mode: 'NONE' } }
      },
      semantics: {
        gemini: {
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
        }
      },
      metadata: {
        context: ctx,
        providerMetadata: { fromContext: 1 }
      }
    },
    {
      context: ctx,
      providerMetadata: { fromContext: 1 }
    }
  );
  assert.equal(builtMetadataFallback.toolConfig.functionCallingConfig.mode, 'NONE');
  assert.equal(builtMetadataFallback.metadata.fromContext, 1);

  const builtExplicitEmpty = buildGeminiRequestFromChat(
    {
      messages: [{ role: 'user', content: 'empty-tools' }],
      tools: [],
      parameters: { model: 'models/gemini-pro', stream: true },
      semantics: { tools: { explicitEmpty: true } },
      metadata: { context: ctx }
    },
    { context: ctx }
  );
  assert.equal(builtExplicitEmpty.metadata.__rcc_tools_field_present, '1');
  assert.equal(builtExplicitEmpty.metadata.__rcc_stream, true);

  const builtAnthropicEntry = buildGeminiRequestFromChat(
    {
      messages: [{ role: 'user', content: 'blocked' }],
      parameters: { model: 'models/gemini-pro' },
      semantics: {
        gemini: {
          providerMetadata: { blocked: true },
          toolConfig: { functionCallingConfig: { mode: 'NONE' } }
        }
      },
      metadata: {
        context: { ...ctx, entryEndpoint: '/v1/messages' },
        providerMetadata: { alsoBlocked: true }
      }
    },
    {
      context: { ...ctx, entryEndpoint: '/v1/messages' },
      providerMetadata: { alsoBlocked: true }
    }
  );
  assert.equal(builtAnthropicEntry.metadata, undefined);
  assert.equal(builtAnthropicEntry.toolConfig.functionCallingConfig.mode, 'NONE');

  const builtAliasAndFallback = buildGeminiRequestFromChat(
    {
      messages: [
        {
          role: 'assistant',
          content: 'tool call invalid json args',
          tool_calls: [{ id: 'tc-1', function: { name: 'web_search_20250305', arguments: '{bad-json' } }]
        },
        { role: 'tool', tool_call_id: 'tc-1', name: 'web_search_20250305', content: 'first-response' }
      ],
      tools: [
        {
          type: 'function',
          name: 'web_search_20250305',
          function: {
            name: 'web_search_20250305',
            parameters: { type: 'object', properties: { query: { type: 'string' } } }
          }
        }
      ],
      toolOutputs: [{ tool_call_id: 'tc-1', name: 'web_search_20250305', content: 'duplicate-response-should-skip' }],
      parameters: { model: 'models/gemini-pro' },
      metadata: { context: ctx }
    },
    { context: ctx }
  );
  assert.equal(builtAliasAndFallback.tools[0].functionDeclarations[0].name, 'websearch');
  assert.equal(builtAliasAndFallback.contents[0].parts[1].functionCall.name, 'websearch');
  assert.equal(builtAliasAndFallback.contents[0].parts[1].functionCall.args._raw, '{bad-json');
  assert.equal(
    builtAliasAndFallback.contents.filter((entry) => entry.parts?.[0]?.functionResponse?.name === 'websearch').length,
    1
  );

  const builtEdgeBranches = buildGeminiRequestFromChat(
    {
      messages: [
        null,
        { role: 'tool', name: 123, content: 'tool-output-with-default-name' },
        {
          role: 'assistant',
          content: 'assistant-edge',
          tool_calls: [
            null,
            { id: '', function: {} },
            { id: 'tc-edge', function: { name: 'exec_command', arguments: { cmd: 'pwd' } } }
          ]
        },
        { role: 'user', content: 'user-edge' }
      ],
      tools: [
        null,
        {
          type: 'function',
          function: {
            name: 'web_search_20250305',
            parameters: { type: 'object', properties: { query: { type: 'string' } } }
          }
        }
      ],
      parameters: 'bad-shape',
      semantics: {
        gemini: {
          providerMetadata: { antigravitySessionId: 'keep-session' }
        }
      },
      metadata: {
        context: { ...ctx, providerId: 'antigravity.any' }
      }
    },
    {
      context: { ...ctx, providerId: 'antigravity.any' }
    }
  );
  assert.equal(typeof builtEdgeBranches.model === 'string' && builtEdgeBranches.model.includes('gemini'), true);
  assert.equal(builtEdgeBranches.metadata.antigravitySessionId, 'keep-session');
  assert.equal(Array.isArray(builtEdgeBranches.contents) && builtEdgeBranches.contents.length > 0, true);
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
