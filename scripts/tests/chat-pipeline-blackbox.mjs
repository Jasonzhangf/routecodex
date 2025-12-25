#!/usr/bin/env node

/**
 * Black-box comparer for chat pipeline codecs.
 *
 * Example:
 *   node scripts/tests/chat-pipeline-blackbox.mjs \
 *     --sample samples/mock-provider/openai-chat/unknown/unknown/20251206/103315/002/request.json \
 *     --legacy ../routecodex-worktree/legacy \
 *     --codec openai --mode request
 *
 * Compares the outbound payload produced by the new code and the legacy worktree.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const CODEC_FILES = {
  openai: {
    className: 'OpenAIOpenAIPipelineCodec',
    path: 'sharedmodule/llmswitch-core/dist/conversion/pipeline/codecs/v2/openai-openai-pipeline.js',
    defaultProfile: {
      id: 'openai-openai',
      codec: 'openai-openai',
      incomingProtocol: 'openai-chat',
      outgoingProtocol: 'openai-chat'
    },
    defaultEndpoint: '/v1/chat/completions'
  },
  anthropic: {
    className: 'AnthropicOpenAIPipelineCodec',
    path: 'sharedmodule/llmswitch-core/dist/conversion/pipeline/codecs/v2/anthropic-openai-pipeline.js',
    defaultProfile: {
      id: 'anthropic-openai',
      codec: 'anthropic-openai',
      incomingProtocol: 'anthropic-messages',
      outgoingProtocol: 'openai-chat'
    },
    defaultEndpoint: '/v1/messages'
  },
  responses: {
    className: 'ResponsesOpenAIPipelineCodec',
    path: 'sharedmodule/llmswitch-core/dist/conversion/pipeline/codecs/v2/responses-openai-pipeline.js',
    defaultProfile: {
      id: 'responses-openai',
      codec: 'responses-openai',
      incomingProtocol: 'openai-chat',
      outgoingProtocol: 'openai-chat'
    },
    defaultEndpoint: '/v1/responses'
  }
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const codecConfig = CODEC_FILES[options.codec];
  if (!codecConfig) {
    throw new Error(`Unsupported codec "${options.codec}". Choices: ${Object.keys(CODEC_FILES).join(', ')}`);
  }
  const [legacyAbs, currentAbs] = [options.legacy, options.current].map((p) => {
    if (!p) {
      throw new Error('Both --legacy and --current path are required');
    }
    return path.resolve(p);
  });

  const sample = await loadSample(options.sample);
  let payload = stripAuxiliaryFields(sample.body ?? sample.payload ?? sample);
  if (payload && typeof payload === 'object') {
    if (payload.payload && payload.protocol && payload.direction) {
      payload = stripAuxiliaryFields(payload.payload);
    } else if (payload.body && payload.body.payload && payload.body.protocol) {
      payload = stripAuxiliaryFields(payload.body.payload);
    }
  }
  const requestId =
    sample.reqId ||
    sample.requestId ||
    sample.meta?.requestId ||
    `cmp_${Date.now()}`;
  const endpoint = sample.meta?.endpoint || codecConfig.defaultEndpoint;
  const baseContext = {
    requestId,
    endpoint,
    entryEndpoint: endpoint,
    metadata: sample.meta?.metadata || {},
    stream: Boolean(payload.stream),
    targetProtocol: codecConfig.defaultProfile.outgoingProtocol
  };

  const dumpRequested = Boolean(options.dumpDir);
  const captureStages = options.stages !== false || dumpRequested;
  const timestampSeed = Date.now();
  const legacyResult = await runCodecComparison({
    repoDir: legacyAbs,
    codecConfig,
    payload,
    context: baseContext,
    mode: options.mode,
    captureStages,
    label: 'legacy',
    timestampSeed
  });
  const currentResult = await runCodecComparison({
    repoDir: currentAbs,
    codecConfig,
    payload,
    context: baseContext,
    mode: options.mode,
    captureStages,
    label: 'current',
    timestampSeed
  });

  const legacyPayload = stripAuxiliaryFields(legacyResult.payload);
  const currentPayload = stripAuxiliaryFields(currentResult.payload);
  console.log(`\n[summary] codec=${options.codec} mode=${options.mode}`);
  logToolSummary('legacy', legacyPayload);
  logToolSummary('current', currentPayload);

  const hasStageExpectations =
    sample.stageExpectations && typeof sample.stageExpectations === 'object' && Object.keys(sample.stageExpectations).length > 0;

  let payloadDiff = false;
  if (options.comparePayload) {
    payloadDiff = await diffObjects({
      legacy: legacyPayload,
      current: currentPayload,
      label: `${options.codec}-${options.mode}`
    });
  } else {
    console.log('\n[diff] Payload diff skipped via flag.');
  }

  const goldenDiff = await validateAgainstGolden({
    sample,
    payload: currentPayload,
    stages: currentResult.stages,
    codec: options.codec,
    mode: options.mode
  });

  let stageDiff = false;
  if (captureStages && options.compareStages && !hasStageExpectations) {
    stageDiff = await diffStageRecords(legacyResult.stages, currentResult.stages);
  } else if (captureStages && hasStageExpectations) {
    console.log('\n[stages] Legacy stage diff skipped (using explicit expectations).');
  } else if (captureStages && !options.compareStages) {
    console.log('\n[stages] Stage diff skipped via flag.');
  }
  if (options.dumpDir) {
    await dumpOutputs({
      dumpDir: options.dumpDir,
      label: options.caseName || deriveCaseName(options.sample),
      samplePath: options.sample,
      mode: options.mode,
      codec: options.codec,
      payload: currentResult.payload,
      stages: currentResult.stages
    });
  }
  const expectationDiff = await compareStageExpectations({
    expectations: sample.stageExpectations,
    stages: currentResult.stages
  });
  const assertionFailure = runPayloadAssertions({
    payload: currentPayload,
    codec: options.codec,
    mode: options.mode,
    assertions: sample.assertions
  });
  const toolMismatch = reportToolDefinitionMismatches({
    payload: currentPayload,
    stages: currentResult.stages,
    label: options.codec,
    mode: options.mode
  });
  if (
    options.failOnDiff &&
    (payloadDiff || stageDiff || expectationDiff || assertionFailure || goldenDiff || toolMismatch)
  ) {
    throw new Error('Differences detected during chat-pipeline comparison');
  }
}

function resolveGoldenExpectations(sample) {
  const expectations = {};
  if (sample.meta?.endpoint && sample.meta?.requestId) {
    const reqId = sample.meta.requestId;
    const endpoint = sample.meta.endpoint;
    const baseDir = path.join(os.homedir(), '.routecodex', 'codex-samples');
    const folder = endpoint.includes('/messages')
      ? 'anthropic-messages'
      : endpoint.includes('/responses')
        ? 'openai-responses'
        : 'openai-chat';
    const defaultPath = path.join(baseDir, folder, `${reqId}_req_inbound_stage2_semantic_map.json`);
    if (!sample.stageExpectations || !sample.stageExpectations.req_inbound_stage2_semantic_map) {
      expectations.req_inbound_stage2_semantic_map = defaultPath;
    }
  }
  return { ...expectations, ...(sample.stageExpectations || {}) };
}

async function validateAgainstGolden({ sample, payload, stages, codec, mode }) {
  const expectations = resolveGoldenExpectations(sample);
  if (!expectations || !Object.keys(expectations).length) {
    return false;
  }
  let hasDiff = false;
  for (const [stage, expectationPath] of Object.entries(expectations)) {
    const resolvedPath = path.resolve(expectationPath);
    let expected;
    try {
      const raw = await fs.readFile(resolvedPath, 'utf-8');
      const parsed = JSON.parse(raw);
      expected = parsed.body ?? parsed;
    } catch (error) {
      console.warn(`[golden] stage ${stage} missing baseline (${resolvedPath}): ${error.message}`);
      hasDiff = true;
      continue;
    }
    const actual = stage === 'payload' ? payload : stages?.[stage] || stages?.[STAGE_KIND_MAP?.[stage]];
    if (!actual) {
      console.log(`[golden] ${stage}: missing in current output`);
      hasDiff = true;
      continue;
    }
    const diffFound = await diffObjects({ legacy: expected, current: actual, label: `golden-${stage}` });
    hasDiff = hasDiff || diffFound;
  }
  return hasDiff;
}

function parseArgs(args) {
  const parsed = {
    codec: 'openai',
    mode: 'request',
    current: process.cwd(),
    stages: true,
    compareStages: true,
    comparePayload: true,
    failOnDiff: false,
    dumpDir: undefined,
    caseName: undefined
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if ((arg === '--sample' || arg === '-s') && i + 1 < args.length) {
      parsed.sample = args[++i];
    } else if ((arg === '--legacy' || arg === '-l') && i + 1 < args.length) {
      parsed.legacy = args[++i];
    } else if ((arg === '--current' || arg === '-c') && i + 1 < args.length) {
      parsed.current = args[++i];
    } else if (arg === '--codec' && i + 1 < args.length) {
      parsed.codec = args[++i].toLowerCase();
    } else if (arg === '--mode' && i + 1 < args.length) {
      const mode = args[++i].toLowerCase();
      if (mode === 'request' || mode === 'response') {
        parsed.mode = mode;
      }
    } else if (arg === '--stages') {
      parsed.stages = true;
    } else if (arg === '--no-stages') {
      parsed.stages = false;
    } else if (arg === '--skip-stage-diff') {
      parsed.compareStages = false;
    } else if (arg === '--skip-payload-diff') {
      parsed.comparePayload = false;
    } else if (arg === '--fail-on-diff') {
      parsed.failOnDiff = true;
    } else if ((arg === '--dump-dir' || arg === '--dump') && i + 1 < args.length) {
      parsed.dumpDir = args[++i];
    } else if ((arg === '--case' || arg === '--case-name') && i + 1 < args.length) {
      parsed.caseName = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }
  if (!parsed.sample) {
    throw new Error('Sample file is required (--sample <path>)');
  }
  if (!parsed.legacy) {
    throw new Error('Legacy worktree path is required (--legacy <path>)');
  }
  return parsed;
}

function printUsage() {
  console.log(
    'Usage: node scripts/tests/chat-pipeline-blackbox.mjs --sample file --legacy dir [--current dir] [--codec openai|anthropic|responses] [--mode request|response] [--stages|--no-stages] [--skip-stage-diff] [--skip-payload-diff] [--fail-on-diff] [--dump-dir path] [--case name]'
  );
}

async function loadSample(samplePath) {
  const abs = path.resolve(samplePath);
  const raw = await fs.readFile(abs, 'utf-8');
  return JSON.parse(raw);
}

async function compareStageExpectations({ expectations, stages }) {
  if (!expectations || typeof expectations !== 'object') {
    return false;
  }
  let hasDiff = false;
  for (const [stage, expectationPath] of Object.entries(expectations)) {
    const resolvedPath = path.resolve(expectationPath);
    let expected;
    try {
      const raw = await fs.readFile(resolvedPath, 'utf-8');
      expected = JSON.parse(raw);
    } catch (error) {
      console.warn(`[stages] expectation for ${stage} missing (${resolvedPath}): ${error.message}`);
      hasDiff = true;
      continue;
    }
    const actual = stages?.[stage];
    if (!actual) {
      console.log(`[stages] ${stage}: missing in current output (expected baseline present)`);
      hasDiff = true;
      continue;
    }
    if (stableJson(sortKeys(actual)) === stableJson(sortKeys(expected))) {
      console.log(`[stages] ${stage}: matches chat baseline`);
      continue;
    }
    console.log(`[stages] ${stage}: differs from chat baseline`);
    const diffFound = await diffObjects({
      legacy: expected,
      current: actual,
      label: `baseline-${stage}`
    });
    hasDiff = hasDiff || diffFound;
  }
  return hasDiff;
}

async function runCodecComparison({ repoDir, codecConfig, payload, context, mode, captureStages, label, timestampSeed }) {
  const moduleUrl = pathToFileURL(path.join(repoDir, codecConfig.path));
  const module = await import(moduleUrl.href);
  const CodecCtor = module[codecConfig.className];
  if (!CodecCtor) {
    throw new Error(`Codec ${codecConfig.className} missing in ${moduleUrl.href}`);
  }
  const codec = new CodecCtor();
  if (typeof codec.initialize === 'function') {
    await codec.initialize();
  }
  const profile = { ...codecConfig.defaultProfile };
  const requestIdBase = sanitizeRequestId(context.requestId || `req_${Date.now()}`);
  const requestId = `${requestIdBase}_${label}_${mode}_${Date.now()}`;
  const contextClone = { ...context, requestId };
  const payloadClone = cloneJson(payload);
  const stageRecords = {};
  let resetInbound;
  let resetOutbound;
  if (captureStages && codec.pipeline && typeof codec.pipeline.convertInbound === 'function') {
    const originalInbound = codec.pipeline.convertInbound.bind(codec.pipeline);
    codec.pipeline.convertInbound = async (...args) => {
      const res = await originalInbound(...args);
      const inboundKey = mode === 'response' ? 'response_inbound' : 'request_inbound';
      stageRecords[inboundKey] = normalizeStageRecord(res?.canonical ?? res);
      return res;
    };
    resetInbound = () => {
      codec.pipeline.convertInbound = originalInbound;
    };
  }
  if (codec.pipeline && typeof codec.pipeline.convertOutbound === 'function') {
    const originalOutbound = codec.pipeline.convertOutbound.bind(codec.pipeline);
    codec.pipeline.convertOutbound = async (...args) => {
      const res = await originalOutbound(...args);
      const key = mode === 'response' ? 'response_outbound' : 'request_outbound';
      stageRecords[key] = normalizeStageRecord(res?.payload ?? res);
      return res;
    };
    resetOutbound = () => {
      codec.pipeline.convertOutbound = originalOutbound;
    };
  }
  const originalNow = Date.now;
  if (typeof timestampSeed === 'number' && Number.isFinite(timestampSeed)) {
    Date.now = () => timestampSeed;
  }
  try {
    const converted =
      mode === 'response'
        ? await codec.convertResponse(payloadClone, profile, contextClone)
        : await codec.convertRequest(payloadClone, profile, contextClone);
    return { payload: converted, moduleUrl: moduleUrl.href, stages: stageRecords };
  } finally {
    Date.now = originalNow;
    if (typeof resetInbound === 'function') resetInbound();
    if (typeof resetOutbound === 'function') resetOutbound();
  }
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stripAuxiliaryFields(value) {
  const cloned = cloneJson(value);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    return cloned;
  }
  const AUX_KEYS = ['stageExpectations', 'stages', 'anthropicMirror', 'toolsFieldPresent'];
  for (const key of AUX_KEYS) {
    if (key in cloned) {
      delete cloned[key];
    }
  }
  return cloned;
}

function logToolSummary(label, payload) {
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  const toolNames = tools
    .map((t) => t?.function?.name || t?.name)
    .filter(Boolean)
    .map((name) => String(name));
  console.log(
    `[${label}] tools=${toolNames.length} ${toolNames.length ? toolNames.join(', ') : '(none)'}`
  );
  const toolCalls = extractToolCalls(payload);
  if (toolCalls && toolCalls.length) {
    const callNames = toolCalls
      .map((call) => call?.function?.name || call?.name)
      .filter(Boolean)
      .map((name) => String(name));
    console.log(
      `[${label}] tool_calls=${callNames.length} ${callNames.join(', ')}`
    );
  }
}

function extractToolCalls(payload) {
  if (!payload) return null;
  if (Array.isArray(payload.tool_calls)) return payload.tool_calls;
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  if (choices.length) {
    const candidate = choices[0]?.message?.tool_calls;
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

function collectMessageToolCallNames(payload) {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const names = [];
  const inspect = (calls) => {
    if (!Array.isArray(calls)) {
      return;
    }
    for (const call of calls) {
      const name = call?.function?.name ?? call?.name;
      if (typeof name === 'string' && name.trim().length) {
        names.push(name.trim());
      }
    }
  };
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const message of messages) {
    inspect(message?.tool_calls);
  }
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    inspect(choice?.message?.tool_calls);
  }
  return names;
}

function collectToolDefinitionNames(payload) {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  return tools
    .map((tool) => tool?.function?.name ?? tool?.name)
    .filter((name) => typeof name === 'string' && name.trim().length)
    .map((name) => name.trim());
}

function findMissingToolDefinitions(payload) {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const declared = collectToolDefinitionNames(payload);
  const callNames = collectMessageToolCallNames(payload);
  if (!callNames.length) {
    return [];
  }
  if (!declared.length) {
    return Array.from(new Set(callNames));
  }
  const declaredSet = new Set(declared);
  const missing = [];
  for (const name of callNames) {
    if (!declaredSet.has(name)) {
      missing.push(name);
    }
  }
  return Array.from(new Set(missing));
}

function buildToolDefinitionIssue(payload, scope) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const missing = findMissingToolDefinitions(payload);
  if (!missing.length) {
    return null;
  }
  return {
    scope,
    missing,
    declared: collectToolDefinitionNames(payload)
  };
}

function reportToolDefinitionMismatches({ payload, stages, label, mode }) {
  const issues = [];
  const payloadIssue = buildToolDefinitionIssue(payload, 'result');
  if (payloadIssue) {
    issues.push(payloadIssue);
  }
  if (stages && typeof stages === 'object') {
    for (const [stageName, stagePayload] of Object.entries(stages)) {
      const issue = buildToolDefinitionIssue(stagePayload, stageName);
      if (issue) {
        issues.push(issue);
      }
    }
  }
  if (!issues.length) {
    return false;
  }
  console.error(
    `[tool-check] Missing tool definitions detected for codec=${label} mode=${mode}`
  );
  for (const issue of issues) {
    console.error(
      `  - scope=${issue.scope} missing=[${issue.missing.join(', ')}] declared=[${issue.declared.join(', ') || '(none)'}]`
    );
  }
  return true;
}

async function diffObjects({ legacy, current, label }) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatcmp-'));
  const legacyPath = path.join(tmpDir, `${label}-legacy.json`);
  const currentPath = path.join(tmpDir, `${label}-current.json`);
  await fs.writeFile(legacyPath, stableJson(legacy), 'utf-8');
  await fs.writeFile(currentPath, stableJson(current), 'utf-8');
  const diff = spawnSync('diff', ['-u', legacyPath, currentPath], { encoding: 'utf-8' });
  if (diff.status === 0) {
    console.log('\n[diff] outputs identical.');
    return false;
  }
  if (diff.status === 1 && diff.stdout) {
    console.log('\n[diff] differences found:\n');
    console.log(diff.stdout);
    return true;
  }
  console.error('[diff] failed to run diff command', diff.stderr || '');
  return true;
}

async function diffStageRecords(legacyStages = {}, currentStages = {}) {
  const allStages = Array.from(new Set([...Object.keys(legacyStages), ...Object.keys(currentStages)])).sort();
  if (!allStages.length) {
    console.log('\n[stages] No stage outputs captured.');
    return false;
  }
  console.log('\n[stages] Stage-by-stage comparison');
  let hasDiff = false;
  for (const stage of allStages) {
    if (!(stage in legacyStages)) {
      console.log(`[stages] ${stage}: missing in legacy output`);
      hasDiff = true;
      continue;
    }
    if (!(stage in currentStages)) {
      console.log(`[stages] ${stage}: missing in current output`);
      hasDiff = true;
      continue;
    }
    const legacy = legacyStages[stage];
    const current = currentStages[stage];
    if (stableJson(legacy) === stableJson(current)) {
      console.log(`[stages] ${stage}: identical`);
      continue;
    }
    console.log(`[stages] ${stage}: differences detected`);
    const stageDiff = await diffObjects({ legacy, current, label: `stage-${stage}` });
    hasDiff = hasDiff || stageDiff;
  }
  return hasDiff;
}

function runPayloadAssertions({ payload, codec, mode, assertions }) {
  if (!assertions || typeof assertions !== 'object') {
    return false;
  }
  let hasFailure = false;
  if (assertions.responsesInputIdPrefix && codec === 'responses' && mode === 'request') {
    const prefix = String(assertions.responsesInputIdPrefix);
    const ids = collectResponsesInputToolIds(payload);
    const offenders = ids.filter((id) => typeof id === 'string' && !id.startsWith(prefix));
    if (offenders.length) {
      console.error(`\n[assertions] responses.input tool IDs missing prefix ${prefix}: ${offenders.join(', ')}`);
      hasFailure = true;
    } else {
      console.log(`\n[assertions] responses.input tool IDs verified (${ids.length} entries, prefix ${prefix}).`);
    }
  }
  return hasFailure;
}

function collectResponsesInputToolIds(payload) {
  const entries = Array.isArray(payload?.input) ? payload.input : [];
  const ids = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
    if (!type) {
      continue;
    }
    if (type === 'function_call' || type === 'functioncall') {
      const callId = (entry.call_id ?? entry.id);
      if (typeof callId === 'string') {
        ids.push(callId);
      }
      continue;
    }
    if (type === 'function_call_output' || type === 'tool_result' || type === 'tool_message' || type === 'functioncalloutput') {
      const callId = entry.call_id ?? entry.tool_call_id ?? entry.id;
      if (typeof callId === 'string') {
        ids.push(callId);
      }
    }
  }
  return ids;
}

function stableJson(value) {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sortKeys(entry));
  }
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value)
      .sort()
      .forEach((key) => {
        out[key] = sortKeys(value[key]);
      });
    return out;
  }
  return value;
}

function sanitizeRequestId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return `req_${Date.now()}`;
  }
  return value.trim().replace(/[^A-Za-z0-9_.-]/g, '_');
}

function normalizeStageRecord(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeStageRecord(entry));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'requestId' || key === 'clientRequestId' || key === 'timestamp') {
        continue;
      }
      out[key] = normalizeStageRecord(entry);
    }
    return out;
  }
  return value;
}

function deriveCaseName(samplePath) {
  try {
    const base = path.basename(samplePath);
    return base.replace(/\.[^.]+$/, '');
  } catch {
    return `case_${Date.now()}`;
  }
}

async function dumpOutputs({ dumpDir, label, samplePath, mode, codec, payload, stages }) {
  const baseDir = path.join(path.resolve(dumpDir), sanitizeLabel(label));
  await fs.mkdir(baseDir, { recursive: true });
  const meta = {
    codec,
    mode,
    sample: path.resolve(samplePath),
    generatedAt: new Date().toISOString()
  };
  const payloadName = mode === 'response' ? 'client_payload.json' : 'provider_payload.json';
  await fs.writeFile(path.join(baseDir, payloadName), stableJson(payload), 'utf-8');
  if (stages && typeof stages === 'object') {
    for (const [stage, data] of Object.entries(stages)) {
      if (!data) continue;
      await fs.writeFile(path.join(baseDir, `${stage}.json`), stableJson(data), 'utf-8');
    }
  }
  const sampleCopyName = mode === 'response' ? 'provider_response.json' : 'input_client.json';
  try {
    await fs.copyFile(path.resolve(samplePath), path.join(baseDir, sampleCopyName));
  } catch {
    // ignore copy errors
  }
  await fs.writeFile(path.join(baseDir, 'meta.json'), stableJson(meta), 'utf-8');
  console.log(`[dump] Saved golden outputs → ${baseDir}`);
}

function sanitizeLabel(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
