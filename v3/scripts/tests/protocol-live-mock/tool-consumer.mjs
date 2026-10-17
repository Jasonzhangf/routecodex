import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { parseClientBody, SUPPORTED_PROTOCOLS } from './protocol-semantics.mjs';

// A consumer value is the only thing that selects an implementation. A tool
// name observed on the wire never grants execution authority by itself.
const EXECUTING_CONSUMERS = Object.freeze(['echo', 'echo-line-result', 'local-namespace-mock', 'unknown-tool-correction']);

// The bounded local mock binding this harness supports. It is an RCC test
// extension: it launches no agent, sends no message, and runs no command.
const LOCAL_MOCK_BINDING = Object.freeze({ namespace: 'collaboration', name: 'spawn_agent', type: 'function' });
const LOCAL_MOCK_ARGUMENT_KEYS = Object.freeze(['message']);
const LOCAL_MOCK_RESPONSE_PREFIX = 'local namespace mock recorded: ';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Default bounded effect adapter: exclusive create plus readback at the
// runner-owned path. Tests may inject an in-memory adapter.
const localFileEffect = Object.freeze({
  create(path, contents) {
    const handle = openSync(path, 'wx');
    try {
      writeSync(handle, contents);
    } finally {
      closeSync(handle);
    }
    return path;
  },
  read(path) {
    return readFileSync(path, 'utf8');
  },
});

// Observe only the client protocol. Provider wire shapes are not client calls.
export function extractToolCalls(entryProtocol, clientResult) {
  if (!SUPPORTED_PROTOCOLS.includes(entryProtocol)) throw new Error(`unsupported tool protocol: ${entryProtocol}`);
  const parsed = typeof clientResult.bodyText === 'string' && clientResult.bodyText.length > 0
    ? parseClientBody(entryProtocol, clientResult.bodyText, clientResult.headers?.['content-type'] ?? '')
    : { semantic: clientResult.body };
  const body = parsed.semantic;
  if (!body) return [];
  let items;
  if (entryProtocol === 'responses') items = body.output ?? body.output_items ?? [];
  if (entryProtocol === 'openai_chat') items = body.tool_calls ?? body.choices?.flatMap((choice) => choice.message?.tool_calls ?? []) ?? [];
  if (entryProtocol === 'anthropic') items = (body.content ?? []).filter((item) => item.type === 'tool_use');
  if (entryProtocol === 'gemini') items = (body.candidates ?? []).flatMap((candidate) => candidate.content?.parts ?? []).filter((part) => part.functionCall).map((part) => part.functionCall);
  return items.filter((item) => entryProtocol !== 'responses' || ['function_call', 'custom_tool_call'].includes(item.type)).map((item) => {
    // Native Gemini functionCall ids are optional. An absent id stays absent
    // (undefined); it is never replaced by a fabricated identity.
    const id = item.call_id ?? item.id;
    const call = {
      id,
      name: item.function?.name ?? item.name,
      type: item.type ?? (entryProtocol === 'gemini' ? 'functionCall' : undefined),
    };
    if (item.namespace !== undefined) call.namespace = item.namespace;
    if (entryProtocol === 'anthropic') call.arguments = item.input;
    else if (entryProtocol === 'gemini') call.arguments = item.args;
    else if (item.type === 'custom_tool_call') {
      call.input = item.input;
      call.arguments = item.input;
    } else call.arguments = item.function?.arguments ?? item.arguments;
    return call;
  });
}

function findDeclaredTool(request, call) {
  const declarations = [];
  for (const tool of request.body?.tools ?? []) {
    if (tool.type === 'namespace') {
      for (const child of tool.tools ?? []) declarations.push({ ...child, namespace: tool.name });
    } else if (tool.function) declarations.push({ ...tool.function, type: tool.type });
    else if (tool.functionDeclarations) declarations.push(...tool.functionDeclarations);
    else declarations.push(tool);
  }
  return declarations.find((tool) => tool.name === call.name && tool.namespace === call.namespace);
}

function declaredTool(request, call) {
  const declaration = findDeclaredTool(request, call);
  if (!declaration) throw new Error(`tool ${call.namespace ? `${call.namespace}.` : ''}${call.name} not declared`);
  const custom = declaration.type === 'custom';
  if (custom !== (call.type === 'custom_tool_call') || (!custom && !['function', 'function_call', 'tool_use', 'functionCall'].includes(call.type))) {
    throw new Error('declared tool type mismatch');
  }
  return declaration;
}

// The declared argument key comes from the tool declaration, never from the
// observed argument object. Native Gemini may declare `text` or `message`.
function echoArgumentKey(declaration) {
  for (const schema of [declaration.parameters, declaration.parametersJsonSchema]) {
    if (!isPlainObject(schema) || !isPlainObject(schema.properties)) continue;
    if (isPlainObject(schema.properties.text)) return 'text';
    if (isPlainObject(schema.properties.message)) return 'message';
  }
  return 'text';
}

function entryProtocolOf(request, entryProtocol) {
  if (typeof entryProtocol === 'string' && entryProtocol.length > 0) return entryProtocol;
  return Array.isArray(request?.body?.contents) ? 'gemini' : '';
}

export function executeDeclaredEchoTool({ request, call, entryProtocol }) {
  const declaration = declaredTool(request, call);
  if (call.name !== 'echo') throw new Error(`tool ${call.name} is not an echo consumer`);
  const protocol = entryProtocolOf(request, entryProtocol);
  const idAbsent = call.id === '' || call.id === undefined || call.id === null;
  if (idAbsent && protocol !== 'gemini') throw new Error('missing observed tool call id');
  if (declaration.type === 'custom') {
    if (typeof call.input !== 'string') throw new Error('custom echo requires raw string input');
    return call.input;
  }
  let args = call.arguments;
  if (typeof args === 'string') args = JSON.parse(args);
  if (!isPlainObject(args) || Object.keys(args).length !== 1) {
    throw new Error('echo requires exactly one declared string argument');
  }
  const key = echoArgumentKey(declaration);
  if (typeof args[key] !== 'string') throw new Error(`echo requires exactly one ${key} string argument`);
  return args[key];
}

// A pure local test function bound to the already-declared `echo` tool. It
// reuses the plain echo declaration binding and argument reading, then returns
// its own fixed business value: the argument text plus one newline and a mock
// exit code of 0. No OS process, shell, stdout, or stderr is involved. It
// receives no fixture, template, or expected output, so nothing but the
// observed call can change the result.
export function executeDeclaredEchoLineResult({ request, call, entryProtocol }) {
  const text = executeDeclaredEchoTool({ request, call, entryProtocol });
  return { output: `${text}\n`, exitCode: 0 };
}

// The response paired to a Gemini functionCall is a function of the declared
// consumer only. The template wrapper is kept, but none of its response
// business fields ever reach the sent request.
function geminiFunctionResponse(consumer, output, responseOverride) {
  if (responseOverride !== undefined) return structuredClone(responseOverride);
  if (consumer === 'echo-line-result') return structuredClone(output);
  return { output };
}

// The recorded execution is the only source of the tool result. After it is
// captured, the actual return must equal the fixture's declared
// expected_output exactly. A mismatch keeps the actual receipt and stops the
// follow-up; nothing is rewritten and no fixture value is executed.
function assertExpectedOutput(fixture, output) {
  const expected = fixture.tool_followup?.expected_output;
  if (expected === undefined) return;
  if (!isDeepStrictEqual(output, expected)) {
    throw new Error(`tool result mismatch: actual ${JSON.stringify(output)} != expected_output ${JSON.stringify(expected)}`);
  }
}

// Parse the bounded local mock arguments. The only supported input contract is
// one JSON object with a single string `message` member.
function parseLocalMockArguments(rawArguments) {
  if (typeof rawArguments !== 'string') throw new Error('local namespace mock requires raw string arguments');
  let parsed;
  try {
    parsed = JSON.parse(rawArguments);
  } catch (error) {
    throw new Error(`local namespace mock arguments are not valid JSON: ${error.message}`);
  }
  if (!isPlainObject(parsed)) throw new Error('local namespace mock requires one object argument');
  const keys = Object.keys(parsed);
  if (keys.length !== LOCAL_MOCK_ARGUMENT_KEYS.length || !LOCAL_MOCK_ARGUMENT_KEYS.every((key) => keys.includes(key))) {
    throw new Error('local namespace mock requires exactly the supported message argument');
  }
  if (typeof parsed.message !== 'string') throw new Error('local namespace mock requires a string message argument');
  return parsed;
}

// Bounded, test-owned mock: one exclusive local file create, one readback, and
// an output derived from the readback content. No shell, subprocess, network,
// or native-agent execution happens anywhere in this path.
export function executeLocalNamespaceMock({ fixture, request, call, effectPath, effect }) {
  const followup = fixture.tool_followup ?? {};
  if (followup.consumer !== 'local-namespace-mock') throw new Error('not declared as a local namespace mock consumer');
  if (followup.side_effect !== 'exclusive-local-file') throw new Error('local namespace mock requires side_effect exclusive-local-file');
  const binding = followup.binding;
  if (!isPlainObject(binding) || binding.namespace !== LOCAL_MOCK_BINDING.namespace || binding.name !== LOCAL_MOCK_BINDING.name || binding.type !== LOCAL_MOCK_BINDING.type) {
    throw new Error(`local namespace mock requires the declared ${LOCAL_MOCK_BINDING.namespace}.${LOCAL_MOCK_BINDING.name} function binding`);
  }
  const declaration = declaredTool(request, call);
  if (declaration.namespace !== binding.namespace || declaration.name !== binding.name || declaration.type !== binding.type) {
    throw new Error('observed call does not match the declared namespace binding');
  }
  if (call.type !== 'function_call' && call.type !== 'function') throw new Error('local namespace mock requires a function call');
  if (typeof call.id !== 'string' || call.id.length === 0) throw new Error('missing observed tool call id');
  if (typeof effectPath !== 'string' || effectPath.trim().length === 0) throw new Error('runner-owned effect path required for the local namespace mock');
  const adapter = effect ?? localFileEffect;
  const args = parseLocalMockArguments(call.arguments);
  const record = {
    call_id: call.id,
    namespace: call.namespace,
    name: call.name,
    arguments: args,
  };
  const serialized = JSON.stringify(record);
  adapter.create(effectPath, serialized);
  const readback = adapter.read(effectPath);
  let recorded;
  try {
    recorded = JSON.parse(readback);
  } catch (error) {
    throw new Error(`local namespace mock effect record is not valid JSON: ${error.message}`);
  }
  if (!isPlainObject(recorded)
    || recorded.call_id !== call.id
    || recorded.namespace !== call.namespace
    || recorded.name !== call.name
    || JSON.stringify(recorded.arguments) !== JSON.stringify(args)) {
    throw new Error('local namespace mock effect record does not match the observed call');
  }
  if (isPlainObject(followup.expected_effect_record)
    && JSON.stringify(recorded) !== JSON.stringify(followup.expected_effect_record)) {
    throw new Error('local namespace mock effect record does not match expected_effect_record');
  }
  return {
    call_id: call.id,
    namespace: call.namespace,
    name: call.name,
    type: call.type,
    raw_arguments: call.arguments,
    arguments: args,
    output: `${LOCAL_MOCK_RESPONSE_PREFIX}${recorded.arguments.message}`,
    effect_receipt: {
      path: effectPath,
      operation: 'exclusive-local-file',
      bytes: Buffer.byteLength(serialized, 'utf8'),
      record: recorded,
    },
  };
}

function callIdField(id) {
  return id === '' || id === undefined || id === null ? {} : { id };
}

// Locate the template's paired functionResponse entry, replace the preceding
// model turn with the parts actually observed from the wire, and inject the
// executed output. The template wrapper (including an absent role and nested
// functionResponse.parts) is preserved except for the injected fields.
function injectGeminiFunctionResponse(contents, observedParts, call, output, options) {
  const target = contents.findIndex((entry) => Array.isArray(entry?.parts)
    && entry.parts.some((part) => matchesFunctionResponse(part, call)));
  if (target < 0) return null;
  const next = structuredClone(contents);
  if (Array.isArray(observedParts)) {
    for (let index = target - 1; index >= 0; index -= 1) {
      const previous = next[index];
      if (isPlainObject(previous) && previous.role === 'model' && Array.isArray(previous.parts)) {
        previous.parts = structuredClone(observedParts);
        break;
      }
    }
  }
  for (const part of next[target].parts) {
    if (!matchesFunctionResponse(part, call)) continue;
    part.functionResponse.response = geminiFunctionResponse(options.consumer, output, options.responseOverride);
  }
  return next;
}

function matchesFunctionResponse(part, call) {
  const response = part?.functionResponse;
  if (!isPlainObject(response) || response.name !== call.name) return false;
  if (call.id === '' || call.id === undefined || call.id === null) return true;
  return response.id === call.id;
}

function followupRequest(fixture, request, call, output, options = {}) {
  const { turnIndex = 1, observedParts, responseOverride, consumer } = options;
  const next = structuredClone(fixture.turns[turnIndex].client_request);
  const protocol = fixture.cell.entry_protocol;
  const namespace = call.namespace === undefined ? {} : { namespace: call.namespace };
  if (protocol === 'responses') {
    const input = request.body.input;
    if (!Array.isArray(input) && typeof input !== 'string') throw new Error('missing originating Responses input');
    const history = Array.isArray(input) ? structuredClone(input) : [{ type: 'message', role: 'user', content: input }];
    const custom = call.type === 'custom_tool_call';
    next.body.input = [...history,
      { type: custom ? 'custom_tool_call' : 'function_call', call_id: call.id, name: call.name, ...namespace, ...(custom ? { input: call.input } : { arguments: call.arguments }) },
      { type: custom ? 'custom_tool_call_output' : 'function_call_output', call_id: call.id, output }];
  } else if (protocol === 'openai_chat') {
    next.body.messages = [...structuredClone(request.body.messages),
      { role: 'assistant', tool_calls: [{ id: call.id, type: call.type, function: { name: call.name, arguments: call.arguments }, ...namespace }] },
      { role: 'tool', tool_call_id: call.id, content: output }];
  } else if (protocol === 'anthropic') {
    next.body.messages = [...structuredClone(request.body.messages),
      { role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.arguments }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: output }] }];
  } else if (protocol === 'gemini') {
    const templateContents = Array.isArray(next.body.contents) ? next.body.contents : null;
    const injected = templateContents
      ? injectGeminiFunctionResponse(templateContents, observedParts, call, output, { responseOverride, consumer })
      : null;
    if (injected) {
      next.body.contents = injected;
    } else {
      const origin = Array.isArray(request.body?.contents) ? structuredClone(request.body.contents) : [];
      next.body.contents = [...origin,
        { role: 'model', parts: observedParts ?? [{ functionCall: { ...callIdField(call.id), name: call.name, args: call.arguments } }] },
        { role: 'user', parts: [{ functionResponse: { ...callIdField(call.id), name: call.name, response: geminiFunctionResponse(consumer, output, responseOverride) } }] }];
    }
  }
  return next;
}

// Read the model parts exactly as the client observed them. SSE frames are
// merged by the shared protocol observation owner, so parts never duplicate.
function observedGeminiParts(result) {
  const parsed = typeof result.bodyText === 'string' && result.bodyText.length > 0
    ? parseClientBody('gemini', result.bodyText, result.headers?.['content-type'] ?? '')
    : { kind: 'json', body: result.body };
  if (parsed.kind === 'sse') {
    return (parsed.semantic?.candidates ?? []).flatMap((candidate) => structuredClone(candidate.content?.parts ?? []));
  }
  return (parsed.body?.candidates ?? []).flatMap((candidate) => structuredClone(candidate.content?.parts ?? []));
}

async function runUnknownToolCorrection({ fixture, firstResult, sendTurn, onExecution, turnResults, executions }) {
  if (fixture.cell.entry_protocol !== 'gemini' || fixture.turns?.length !== 3) {
    throw new Error('unknown-tool-correction requires three Gemini turns');
  }
  const request = fixture.turns[0]?.client_request ?? fixture.client_request;
  const calls = extractToolCalls('gemini', firstResult);
  if (calls.length !== 1) throw new Error('correction requires exactly one observed unknown call');
  const call = calls[0];
  if (typeof call.id !== 'string' || call.id.length === 0 || typeof call.name !== 'string' || call.name.length === 0) {
    throw new Error('correction requires the observed call id and name');
  }
  if (findDeclaredTool(request, call)) throw new Error('correction first call must be undeclared');
  // The denied model call is never dispatched. The client authors its error
  // from the observed identity and keeps every native part and signature.
  const errorResponse = { error: { code: 'unknown_tool', message: `unknown tool ${call.name}` } };
  const errorRequest = followupRequest(fixture, request, call, undefined, {
    turnIndex: 1,
    observedParts: observedGeminiParts(firstResult),
    responseOverride: errorResponse,
    consumer: 'unknown-tool-correction',
  });
  const correctedResult = await sendTurn(errorRequest, 1);
  turnResults.push(correctedResult);
  const correctedCalls = extractToolCalls('gemini', correctedResult);
  if (correctedCalls.length !== 1) throw new Error('correction requires exactly one corrected declared call');
  const corrected = correctedCalls[0];
  const output = executeDeclaredEchoTool({ request, call: corrected, entryProtocol: 'gemini' });
  executions.push({ ...corrected, output });
  if (typeof onExecution === 'function') onExecution(executions[executions.length - 1]);
  assertExpectedOutput(fixture, output);
  const finalRequest = followupRequest(fixture, errorRequest, corrected, output, {
    turnIndex: 2,
    observedParts: observedGeminiParts(correctedResult),
    consumer: 'unknown-tool-correction',
  });
  turnResults.push(await sendTurn(finalRequest, 2));
}

export async function runToolFollowup({ fixture, firstResult, sendTurn, effectPath, effect, onExecution }) {
  const turnResults = [firstResult];
  const executions = [];
  const diagnostics = [];
  let localInvocation = null;
  try {
    const consumer = fixture.tool_followup?.consumer;
    if (!EXECUTING_CONSUMERS.includes(consumer)) throw new Error(`unsupported tool consumer: ${consumer ?? 'null'}`);
    if (!fixture.turns?.[1]?.client_request) throw new Error('missing follow-up request');
    if (consumer === 'unknown-tool-correction') {
      await runUnknownToolCorrection({ fixture, firstResult, sendTurn, onExecution, turnResults, executions });
      return { turnResults, executions, diagnostics, ok: true, localInvocation };
    }
    const calls = extractToolCalls(fixture.cell.entry_protocol, firstResult);
    const echoLike = consumer === 'echo' || consumer === 'echo-line-result';
    if (echoLike) {
      if (calls.length === 0) throw new Error('no observed echo tool call');
      if (calls.length !== 1) throw new Error('echo consumer requires exactly one observed call');
    } else {
      if (calls.length === 0) throw new Error('no observed local namespace mock call');
      if (calls.length !== 1) throw new Error('local namespace mock requires exactly one observed call');
    }
    const request = fixture.turns[0]?.client_request ?? fixture.client_request;
    const call = calls[0];
    // The real effect and its receipt are recorded before the next request, so
    // a later failure still keeps proof that the operation happened once.
    if (echoLike) {
      const observedParts = fixture.cell.entry_protocol === 'gemini' ? observedGeminiParts(firstResult) : undefined;
      const output = consumer === 'echo'
        ? executeDeclaredEchoTool({ request, call, entryProtocol: fixture.cell.entry_protocol })
        : executeDeclaredEchoLineResult({ request, call, entryProtocol: fixture.cell.entry_protocol });
      executions.push({ ...call, output });
      if (typeof onExecution === 'function') onExecution(executions[executions.length - 1]);
      // The receipt is the sole truth of what the function returned, and it is
      // checked against the declared expectation before anything is sent.
      assertExpectedOutput(fixture, output);
      const next = followupRequest(fixture, request, call, output, { observedParts, consumer });
      turnResults.push(await sendTurn(next, 1));
    } else {
      const invocation = executeLocalNamespaceMock({ fixture, request, call, effectPath, effect });
      localInvocation = invocation;
      const next = followupRequest(fixture, request, call, invocation.output);
      executions.push(invocation);
      if (typeof onExecution === 'function') onExecution(invocation);
      assertExpectedOutput(fixture, invocation.output);
      turnResults.push(await sendTurn(next, 1));
    }
  } catch (error) {
    diagnostics.push(error.message);
  }
  return {
    turnResults,
    executions,
    diagnostics,
    ok: diagnostics.length === 0,
    localInvocation,
  };
}
