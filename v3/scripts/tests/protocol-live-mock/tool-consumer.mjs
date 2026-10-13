import { parseClientBody, SUPPORTED_PROTOCOLS } from './protocol-semantics.mjs';

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
    const call = {
      id: item.call_id ?? item.id,
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

function declaredTool(request, call) {
  const declarations = [];
  for (const tool of request.body?.tools ?? []) {
    if (tool.type === 'namespace') {
      for (const child of tool.tools ?? []) declarations.push({ ...child, namespace: tool.name });
    } else if (tool.function) declarations.push({ ...tool.function, type: tool.type });
    else if (tool.functionDeclarations) declarations.push(...tool.functionDeclarations);
    else declarations.push(tool);
  }
  const declaration = declarations.find((tool) => tool.name === call.name && tool.namespace === call.namespace);
  if (!declaration) throw new Error(`tool ${call.namespace ? `${call.namespace}.` : ''}${call.name} not declared`);
  const custom = declaration.type === 'custom';
  if (custom !== (call.type === 'custom_tool_call') || (!custom && !['function', 'function_call', 'tool_use', 'functionCall'].includes(call.type))) {
    throw new Error('declared tool type mismatch');
  }
  return declaration;
}

export function executeDeclaredEchoTool({ request, call }) {
  const declaration = declaredTool(request, call);
  if (call.name !== 'echo') throw new Error(`tool ${call.name} is not an echo consumer`);
  if (typeof call.id !== 'string' || call.id.length === 0) throw new Error('missing observed tool call id');
  if (declaration.type === 'custom') {
    if (typeof call.input !== 'string') throw new Error('custom echo requires raw string input');
    return call.input;
  }
  let args = call.arguments;
  if (typeof args === 'string') args = JSON.parse(args);
  if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).length !== 1 || typeof args.text !== 'string') {
    throw new Error('echo requires exactly one text string argument');
  }
  return args.text;
}

function followupRequest(fixture, request, call, output) {
  const next = structuredClone(fixture.turns[1].client_request);
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
    next.body.contents = [...structuredClone(request.body.contents),
      { role: 'model', parts: [{ functionCall: { id: call.id, name: call.name, args: call.arguments } }] },
      { role: 'user', parts: [{ functionResponse: { id: call.id, name: call.name, response: { output } } }] }];
  }
  return next;
}

export async function runToolFollowup({ fixture, firstResult, sendTurn }) {
  const turnResults = [firstResult];
  const executions = [];
  const diagnostics = [];
  try {
    if (fixture.tool_followup?.consumer !== 'echo') throw new Error('not declared as an echo consumer');
    if (!fixture.turns?.[1]?.client_request) throw new Error('missing follow-up request');
    const calls = extractToolCalls(fixture.cell.entry_protocol, firstResult);
    if (calls.length === 0) throw new Error('no observed echo tool call');
    if (calls.length !== 1) throw new Error('echo consumer requires exactly one observed call');
    const request = fixture.turns[0]?.client_request ?? fixture.client_request;
    const call = calls[0];
    const output = executeDeclaredEchoTool({ request, call });
    const next = followupRequest(fixture, request, call, output);
    executions.push({ ...call, output });
    turnResults.push(await sendTurn(next, 1));
  } catch (error) {
    diagnostics.push(error.message);
  }
  return { turnResults, executions, diagnostics, ok: diagnostics.length === 0 };
}
