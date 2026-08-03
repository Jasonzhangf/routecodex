#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const failures = [];
const files = {
  v2Gate: 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/provider_action_gate.rs',
  v2Napi: 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
  v2Host: 'src/modules/llmswitch/bridge/provider-action-gate-host.ts',
  v2Queue: 'src/server/runtime/http-server/executor/request-executor-error-action-queue.ts',
  v2Plan: 'src/server/runtime/http-server/executor/request-executor-provider-failure-plan.ts',
  v2Handler: 'src/server/handlers/handler-utils.ts',
  v2Projection: 'src/server/utils/http-error-mapper.ts',
  gate: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
  policy: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
  policyTests: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy/tests.rs',
  error: 'v3/crates/routecodex-v3-error/src/lib.rs',
  direct: 'v3/crates/routecodex-v3-runtime/src/kernel.rs',
  directHelpers: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs',
  directUnitTests: 'v3/crates/routecodex-v3-runtime/src/kernel/tests.rs',
  directExactPinTests: 'v3/crates/routecodex-v3-runtime/src/kernel/tests/exact_pin.rs',
  directSse: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs',
  responses: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  responsesMaterializer: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/provider_stream_materialization.rs',
  responsesCodec: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/responses_provider_event_codec.rs',
  openaiChat: 'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs',
  anthropic: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
  gemini: 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs',
  server: 'v3/crates/routecodex-v3-server/src/lib.rs',
  serverTests: 'v3/crates/routecodex-v3-server/src/tests/mod.rs',
  gateTests: 'v3/crates/routecodex-v3-runtime/tests/provider_action_gate_contract.rs',
  openaiChatTests: 'v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs',
  geminiTests: 'v3/crates/routecodex-v3-runtime/tests/gemini_relay_runtime_integration.rs',
  directSseTests: 'v3/crates/routecodex-v3-runtime/tests/responses_direct_remote_continuation_integration.rs',
  responsesRelayTests: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_runtime_closeout.rs',
  directTests: 'v3/crates/routecodex-v3-runtime/tests/responses_direct_tool_passthrough.rs',
  errorTests: 'v3/crates/routecodex-v3-error/tests/typed_error05_terminal_contract.rs',
  v2FunctionMap: 'docs/architecture/function-map.yml',
  v2ResourceMap: 'docs/architecture/resource-operation-map.yml',
  v2MainlineMap: 'docs/architecture/mainline-call-map.yml',
  v2VerificationMap: 'docs/architecture/verification-map.yml',
  v2BindingBudget: 'docs/architecture/mainline-binding-budget.yml',
  v2Manifest: 'docs/architecture/manifests/error.provider_action_gate.mainline.yml',
  v2Wiki: 'docs/architecture/wiki/error-provider-action-gate-mainline.md',
  functionMap: 'docs/architecture/v3-function-map.yml',
  resourceMap: 'docs/architecture/v3-resource-operation-map.yml',
  mainlineMap: 'docs/architecture/v3-mainline-call-map.yml',
  verificationMap: 'docs/architecture/v3-verification-map.yml',
  manifest: 'docs/architecture/manifests/v3.provider_action_gate.mainline.yml',
  wiki: 'docs/architecture/wiki/v3-provider-action-gate.md',
  plan: 'docs/goals/direct-relay-cross-request-error-storm-control-plan.md',
  packageJson: 'package.json',
  workflow: '.github/workflows/test.yml',
};

const abs = (rel) => path.join(root, rel);
const read = (rel) => {
  try {
    return fs.readFileSync(abs(rel), 'utf8');
  } catch (error) {
    failures.push(`${rel}: cannot read: ${error.message}`);
    return '';
  }
};
const requireText = (text, rel, token) => {
  if (!text.includes(token)) failures.push(`${rel}: missing ${token}`);
};
const requireOccurrenceCount = (text, rel, token, minimum) => {
  const count = text.split(token).length - 1;
  if (count < minimum) {
    failures.push(`${rel}: expected at least ${minimum} occurrences of ${token}, found ${count}`);
  }
};
const parseYaml = (rel) => {
  try {
    return YAML.parse(read(rel));
  } catch (error) {
    failures.push(`${rel}: YAML parse failed: ${error.message}`);
    return {};
  }
};
const asArray = (value) => (Array.isArray(value) ? value : []);
const stringSet = (value) => new Set(asArray(value).filter((row) => typeof row === 'string'));
const assertIncludes = (actual, required, where) => {
  const values = stringSet(actual);
  for (const value of required) {
    if (!values.has(value)) failures.push(`${where}: missing binding ${value}`);
  }
};
const assertExactStrings = (actual, required, where) => {
  const rows = asArray(actual).filter((row) => typeof row === 'string');
  const values = new Set(rows);
  const expected = new Set(required);
  if (rows.length !== values.size) failures.push(`${where}: contains duplicate bindings`);
  for (const value of expected) {
    if (!values.has(value)) failures.push(`${where}: missing binding ${value}`);
  }
  for (const value of values) {
    if (!expected.has(value)) failures.push(`${where}: unexpected binding ${value}`);
  }
};
const simpleSymbol = (symbol) => String(symbol || '').split('::').at(-1);
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const extractWikiStepIds = (source, prefix) => [
  ...source.matchAll(new RegExp(`\\|(${escapeRegExp(prefix)}\\d{2})\\|`, 'gu')),
].map((match) => match[1]);

function assertWikiEdge(source, rel, stepId, fromAlias, toAlias) {
  const pattern = new RegExp(
    `^\\s*${escapeRegExp(fromAlias)}\\s*-->\\|${escapeRegExp(stepId)}\\|\\s*${escapeRegExp(toAlias)}\\s*$`,
    'mu',
  );
  if (!pattern.test(source)) {
    failures.push(`${rel}: ${stepId} must be ${fromAlias} -> ${toAlias}`);
  }
}

function extractSingleMermaidBlock(source, rel) {
  const blocks = [...source.matchAll(/```mermaid\s*\n([\s\S]*?)```/gu)].map((match) => match[1]);
  if (blocks.length !== 1) {
    failures.push(`${rel}: expected exactly one Mermaid lifecycle block`);
    return '';
  }
  return blocks[0];
}

function assertRustTest(source, rel, testName) {
  const code = maskCommentsAndStrings(source);
  const pattern = new RegExp(
    `#\\s*\\[\\s*(?:tokio::)?test\\s*\\]\\s*(?:async\\s+)?fn\\s+${escapeRegExp(testName)}\\b`,
    'u',
  );
  if (!pattern.test(code)) failures.push(`${rel}: missing active Rust test ${testName}`);
}

function maskCommentsAndStrings(source) {
  const output = [...source];
  const mask = (index) => {
    if (output[index] !== '\n' && output[index] !== '\r') output[index] = ' ';
  };
  let index = 0;
  while (index < source.length) {
    if (source.startsWith('//', index)) {
      while (index < source.length && source[index] !== '\n') {
        mask(index);
        index += 1;
      }
      continue;
    }
    if (source.startsWith('/*', index)) {
      let depth = 0;
      while (index < source.length) {
        if (source.startsWith('/*', index)) {
          mask(index);
          mask(index + 1);
          depth += 1;
          index += 2;
          continue;
        }
        if (source.startsWith('*/', index)) {
          mask(index);
          mask(index + 1);
          depth -= 1;
          index += 2;
          if (depth === 0) break;
          continue;
        }
        mask(index);
        index += 1;
      }
      continue;
    }
    const rawMatch = /^(?:br|r)(#*)"/u.exec(source.slice(index));
    if (rawMatch) {
      const terminator = `"${rawMatch[1]}`;
      const start = index;
      index += rawMatch[0].length;
      const end = source.indexOf(terminator, index);
      index = end < 0 ? source.length : end + terminator.length;
      for (let cursor = start; cursor < index; cursor += 1) mask(cursor);
      continue;
    }
    if (source[index] === '"' || source[index] === '`') {
      const quote = source[index];
      mask(index);
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          mask(index);
          if (index + 1 < source.length) mask(index + 1);
          index += 2;
          continue;
        }
        const done = source[index] === quote;
        mask(index);
        index += 1;
        if (done) break;
      }
      continue;
    }
    if (source[index] === "'") {
      let closing = index + 1;
      if (source[closing] === '\\') closing += 2;
      else closing += 1;
      if (source[closing] === "'") {
        for (let cursor = index; cursor <= closing; cursor += 1) mask(cursor);
        index = closing + 1;
        continue;
      }
    }
    index += 1;
  }
  return output.join('');
}

function findFunctionBody(source, symbol, rel) {
  const code = maskCommentsAndStrings(source);
  const name = simpleSymbol(symbol);
  const definition = new RegExp(`\\b(?:function|fn)\\s+${escapeRegExp(name)}\\b`, 'u');
  const match = definition.exec(code);
  if (!match) {
    failures.push(`${rel}: declared symbol not found: ${symbol}`);
    return '';
  }
  const parametersStart = code.indexOf('(', match.index + match[0].length);
  if (parametersStart < 0) {
    failures.push(`${rel}: cannot locate parameter list for ${symbol}`);
    return '';
  }
  let parenDepth = 0;
  let bodyStart = -1;
  for (let index = parametersStart; index < code.length; index += 1) {
    const char = code[index];
    if (char === '(') parenDepth += 1;
    else if (char === ')') parenDepth -= 1;
    else if (char === '{' && parenDepth === 0) {
      bodyStart = index;
      break;
    }
  }
  if (bodyStart < 0) {
    failures.push(`${rel}: cannot locate function body for ${symbol}`);
    return '';
  }
  let braceDepth = 0;
  for (let index = bodyStart; index < code.length; index += 1) {
    const char = code[index];
    if (char === '{') braceDepth += 1;
    else if (char === '}') {
      braceDepth -= 1;
      if (braceDepth === 0) return code.slice(bodyStart, index + 1);
    }
  }
  failures.push(`${rel}: unterminated function body for ${symbol}`);
  return '';
}

function assertCallerInvokesCallee(edge) {
  const callerSource = read(edge.caller_file);
  const calleeSource = read(edge.callee_file);
  findFunctionBody(calleeSource, edge.callee_symbol, edge.callee_file);
  const body = findFunctionBody(callerSource, edge.caller_symbol, edge.caller_file);
  if (!body) return;
  const calleeName = simpleSymbol(edge.callee_symbol);
  const shadowPattern = new RegExp(
    `\\b(?:const|let|var|function|class|fn|struct|enum|trait)\\s+(?:mut\\s+)?${escapeRegExp(calleeName)}\\b`,
    'u',
  );
  if (shadowPattern.test(body)) {
    failures.push(
      `${edge.step_id}: ${edge.caller_symbol} shadows declared callee ${edge.callee_symbol}`,
    );
    return;
  }
  const callPattern = edge.call_witness ?? new RegExp(
    `(?:\\.|::|\\b)${escapeRegExp(calleeName)}\\s*(?:::<[^>{}]*>)?\\s*\\(`,
    'u',
  );
  const callbackCallPattern = new RegExp(
    `\\.(?:map|and_then)\\s*\\(\\s*${escapeRegExp(calleeName)}\\b`,
    'u',
  );
  if (!callPattern.test(body) && !callbackCallPattern.test(body)) {
    failures.push(
      `${edge.step_id}: ${edge.caller_symbol} in ${edge.caller_file} does not call ${edge.callee_symbol}`,
    );
  }
}

const requiredV2Edges = [
  {
    step_id: 'error-provider-action-gate-01',
    from_node: 'ErrorErr05ExecutionDecision',
    to_node: 'ProviderActionGateFailureRecorded',
    caller_symbol: 'resolveRequestExecutorProviderFailurePlan',
    caller_file: files.v2Plan,
    callee_symbol: 'recordErrorActionBackoff',
    callee_file: files.v2Queue,
    call_witness: /\brecordErrorActionBackoff\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'error.provider_action_gate',
  },
  {
    step_id: 'error-provider-action-gate-02',
    from_node: 'ProviderActionGateFailureRecorded',
    to_node: 'ProviderActionGateAdmission',
    caller_symbol: 'resolveRequestExecutorProviderFailurePlan',
    caller_file: files.v2Plan,
    callee_symbol: 'waitErrorActionBackoffWithGate',
    callee_file: files.v2Queue,
    call_witness: /\bwaitErrorActionBackoffWithGate\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'error.provider_action_gate',
  },
  {
    step_id: 'error-provider-action-gate-03',
    from_node: 'ProviderActionGateAdmission',
    to_node: 'ProviderActionGateTerminalCommitRequested',
    caller_symbol: 'waitErrorActionBackoffWithGate',
    caller_file: files.v2Queue,
    callee_symbol: 'commitProviderActionTerminalNative',
    callee_file: files.v2Host,
    call_witness: /\bcommitProviderActionTerminalNative\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'error.provider_action_gate',
  },
  {
    step_id: 'error-provider-action-gate-04',
    from_node: 'ProviderActionGateTerminalCommitRequested',
    to_node: 'ProviderActionGateTerminalCommitted',
    caller_symbol: 'commit_provider_action_terminal_json',
    caller_file: files.v2Napi,
    callee_symbol: 'commit_terminal',
    callee_file: files.v2Gate,
    call_witness: /\bprovider_action_gate::commit_terminal\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'error.provider_action_gate',
  },
  {
    step_id: 'error-provider-action-gate-05',
    from_node: 'ProviderActionGateAdmission',
    to_node: 'ProviderActionGateSuccessRequested',
    caller_symbol: 'recordErrorActionSuccessByLaneGroup',
    caller_file: files.v2Queue,
    callee_symbol: 'recordProviderActionSuccessNative',
    callee_file: files.v2Host,
    call_witness: /\brecordProviderActionSuccessNative\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'error.provider_action_gate',
  },
  {
    step_id: 'error-provider-action-gate-06',
    from_node: 'ProviderActionGateSuccessRequested',
    to_node: 'ProviderActionGateSuccessCommitted',
    caller_symbol: 'record_provider_action_success_json',
    caller_file: files.v2Napi,
    callee_symbol: 'record_success',
    callee_file: files.v2Gate,
    call_witness: /\bprovider_action_gate::record_success\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'error.provider_action_gate',
  },
  {
    step_id: 'error-provider-action-gate-07',
    from_node: 'ProviderActionGateAdmission',
    to_node: 'ProviderActionGateAbandonRequested',
    caller_symbol: 'waitErrorActionBackoffWithGate',
    caller_file: files.v2Queue,
    callee_symbol: 'abandonProviderActionAdmissionNative',
    callee_file: files.v2Host,
    call_witness: /\babandonProviderActionAdmissionNative\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'error.provider_action_gate',
  },
  {
    step_id: 'error-provider-action-gate-08',
    from_node: 'ProviderActionGateAbandonRequested',
    to_node: 'ProviderActionGateAbandoned',
    caller_symbol: 'abandon_provider_action_admission_json',
    caller_file: files.v2Napi,
    callee_symbol: 'abandon_admission',
    callee_file: files.v2Gate,
    call_witness: /\bprovider_action_gate::abandon_admission\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'error.provider_action_gate',
  },
];

const requiredV3Edges = [
  {
    step_id: 'v3-provider-action-gate-01',
    from_node: 'ProviderReqCompat06ProviderCompat',
    to_node: 'V3Error05ExecutionDecision',
    caller_symbol: 'execute_v3_responses_relay_runtime_inner',
    caller_file: files.responses,
    callee_symbol: 'handle_v3_responses_relay_provider_failure',
    callee_file: files.responses,
    call_witness: /\bhandle_v3_responses_relay_provider_failure\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-02',
    from_node: 'V3ProviderReqOutbound08WirePayload',
    to_node: 'V3Error05ExecutionDecision',
    caller_symbol: 'execute_v3_responses_relay_runtime_inner',
    caller_file: files.responses,
    callee_symbol: 'handle_v3_responses_relay_provider_failure',
    callee_file: files.responses,
    call_witness: /\bhandle_v3_responses_relay_provider_failure\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-03',
    from_node: 'V3Error05ExecutionDecision',
    to_node: 'V3Error05RecoveryWitness',
    caller_symbol: 'run_v3_relay_provider_failure_policy',
    caller_file: files.policy,
    callee_symbol: 'V3ProviderFailureRuntimeHealth::record_provider_action_failure_in_scope',
    callee_file: files.policy,
    call_witness: /\bcontext\s*\.\s*provider_health\s*\.\s*record_provider_action_failure_in_scope\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-04',
    from_node: 'V3Error05RecoveryWitness',
    to_node: 'V3ProviderActionGateAdmission',
    caller_symbol: 'V3ProviderFailureRuntimeHealth::wait_for_error05_recovery',
    caller_file: files.policy,
    callee_symbol: 'V3ProviderActionGate::wait_for_recovery_witness',
    callee_file: files.gate,
    call_witness: /\bself\s*\.\s*action_gate\s*\.\s*wait_for_recovery_witness\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-05',
    from_node: 'V3Error05ExecutionDecision',
    to_node: 'V3ProviderActionGateTerminalAdmission',
    caller_symbol: 'run_v3_relay_provider_failure_policy',
    caller_file: files.policy,
    callee_symbol: 'V3ProviderFailureRuntimeHealth::wait_for_terminal_provider_projection_in_scope',
    callee_file: files.policy,
    call_witness: /\bcontext\s*\.\s*provider_health\s*\.\s*wait_for_terminal_provider_projection_in_scope\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-06',
    from_node: 'V3ProviderActionGateTerminalAdmission',
    to_node: 'V3ProviderActionGateTerminalCommitted',
    caller_symbol: 'V3ProviderActionGate::record_failure_and_wait_for_terminal_projection',
    caller_file: files.gate,
    callee_symbol: 'V3ProviderActionGate::commit_terminal_admission',
    callee_file: files.gate,
    call_witness: /\bself\s*\.\s*commit_terminal_admission\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-07',
    from_node: 'V3ProviderActionGateAdmission',
    to_node: 'V3ExecutionRetryOrReselect',
    caller_symbol: 'V3ProviderFailureRuntimeHealth::wait_for_exact_selected_provider_action',
    caller_file: files.policy,
    callee_symbol: 'V3ProviderActionGate::wait_for_exact_provider_action',
    callee_file: files.gate,
    call_witness: /\bself\s*\.\s*action_gate\s*\.\s*wait_for_exact_provider_action\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-08',
    from_node: 'V3Error05RecoveryWitness',
    to_node: 'V3ProviderActionGateAdmission',
    caller_symbol: 'execute_v3_responses_direct_runtime_kernel_core',
    caller_file: files.direct,
    callee_symbol: 'V3ProviderFailureRuntimeHealth::wait_for_error05_recovery',
    callee_file: files.policy,
    call_witness: /\bprovider_health\s*\.\s*wait_for_error05_recovery\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-09',
    from_node: 'V3ExecutionRetryOrReselect',
    to_node: 'V3ProviderActionGateAdmission',
    caller_symbol: 'execute_v3_responses_direct_runtime_kernel_core',
    caller_file: files.direct,
    callee_symbol: 'V3ProviderFailureRuntimeHealth::wait_for_exact_selected_provider_action',
    callee_file: files.policy,
    call_witness: /\bprovider_health\s*\.\s*wait_for_exact_selected_provider_action\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-10',
    from_node: 'V3Error05RecoveryWitness',
    to_node: 'V3ProviderActionGateAdmission',
    caller_symbol: 'execute_v3_responses_relay_runtime_inner',
    caller_file: files.responses,
    callee_symbol: 'V3ProviderFailureRuntimeHealth::wait_for_error05_recovery',
    callee_file: files.policy,
    call_witness: /\bprovider_health\s*\.\s*wait_for_error05_recovery\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-11',
    from_node: 'V3Error05RecoveryWitness',
    to_node: 'V3ProviderActionGateAdmission',
    caller_symbol: 'execute_v3_anthropic_relay_runtime_inner',
    caller_file: files.anthropic,
    callee_symbol: 'V3ProviderFailureRuntimeHealth::wait_for_error05_recovery',
    callee_file: files.policy,
    call_witness: /\bprovider_health\s*\.\s*wait_for_error05_recovery\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-12',
    from_node: 'V3Error05RecoveryWitness',
    to_node: 'V3ProviderActionGateAdmission',
    caller_symbol: 'execute_v3_openai_chat_relay_runtime_inner',
    caller_file: files.openaiChat,
    callee_symbol: 'V3ProviderFailureRuntimeHealth::wait_for_error05_recovery',
    callee_file: files.policy,
    call_witness: /\bprovider_health\s*\.\s*wait_for_error05_recovery\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-13',
    from_node: 'V3Error05RecoveryWitness',
    to_node: 'V3ProviderActionGateAdmission',
    caller_symbol: 'execute_v3_gemini_relay_runtime_inner',
    caller_file: files.gemini,
    callee_symbol: 'V3ProviderFailureRuntimeHealth::wait_for_error05_recovery',
    callee_file: files.policy,
    call_witness: /\bprovider_health\s*\.\s*wait_for_error05_recovery\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-14',
    from_node: 'V3Error01SourceRaised',
    to_node: 'V3Error05ExecutionDecision',
    caller_symbol: 'execute_v3_responses_direct_runtime_kernel_core',
    caller_file: files.direct,
    callee_symbol: 'run_v3_direct_provider_failure_policy',
    callee_file: files.directHelpers,
    call_witness: /\brun_v3_direct_provider_failure_policy\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-15',
    from_node: 'V3Error01SourceRaised',
    to_node: 'V3Error05ExecutionDecision',
    caller_symbol: 'handle_v3_responses_relay_provider_failure',
    caller_file: files.responses,
    callee_symbol: 'run_v3_relay_provider_failure_policy',
    callee_file: files.policy,
    call_witness: /\brun_v3_relay_provider_failure_policy\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-16',
    from_node: 'V3Error01SourceRaised',
    to_node: 'V3Error05ExecutionDecision',
    caller_symbol: 'handle_provider_failure',
    caller_file: files.anthropic,
    callee_symbol: 'run_v3_relay_provider_failure_policy',
    callee_file: files.policy,
    call_witness: /\brun_v3_relay_provider_failure_policy\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-17',
    from_node: 'V3Error01SourceRaised',
    to_node: 'V3Error05ExecutionDecision',
    caller_symbol: 'handle_provider_failure',
    caller_file: files.openaiChat,
    callee_symbol: 'run_v3_relay_provider_failure_policy',
    callee_file: files.policy,
    call_witness: /\brun_v3_relay_provider_failure_policy\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-18',
    from_node: 'V3Error01SourceRaised',
    to_node: 'V3Error05ExecutionDecision',
    caller_symbol: 'handle_provider_failure',
    caller_file: files.gemini,
    callee_symbol: 'run_v3_relay_provider_failure_policy',
    callee_file: files.policy,
    call_witness: /\brun_v3_relay_provider_failure_policy\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-19',
    from_node: 'V3ProviderActionGateAdmission',
    to_node: 'V3ProviderActionPermitInFlight',
    caller_symbol: 'execute_v3_responses_direct_runtime_kernel_core',
    caller_file: files.direct,
    callee_symbol: 'V3ProviderActionAdmission::take_permit',
    callee_file: files.gate,
    call_witness: /\badmission\s*\.\s*take_permit\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-20',
    from_node: 'V3ProviderActionGateAdmission',
    to_node: 'V3ProviderActionPermitInFlight',
    caller_symbol: 'execute_v3_responses_relay_runtime_inner',
    caller_file: files.responses,
    callee_symbol: 'V3ProviderActionAdmission::take_permit',
    callee_file: files.gate,
    call_witness: /\badmission\s*\.\s*take_permit\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-21',
    from_node: 'V3ProviderActionGateAdmission',
    to_node: 'V3ProviderActionPermitInFlight',
    caller_symbol: 'execute_v3_anthropic_relay_runtime_inner',
    caller_file: files.anthropic,
    callee_symbol: 'V3ProviderActionAdmission::take_permit',
    callee_file: files.gate,
    call_witness: /\badmission\s*\.\s*take_permit\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-22',
    from_node: 'V3ProviderActionGateAdmission',
    to_node: 'V3ProviderActionPermitInFlight',
    caller_symbol: 'execute_v3_openai_chat_relay_runtime_inner',
    caller_file: files.openaiChat,
    callee_symbol: 'V3ProviderActionAdmission::take_permit',
    callee_file: files.gate,
    call_witness: /\badmission\s*\.\s*take_permit\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-23',
    from_node: 'V3ProviderActionGateAdmission',
    to_node: 'V3ProviderActionPermitInFlight',
    caller_symbol: 'execute_v3_gemini_relay_runtime_inner',
    caller_file: files.gemini,
    callee_symbol: 'V3ProviderActionAdmission::take_permit',
    callee_file: files.gate,
    call_witness: /\badmission\s*\.\s*take_permit\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-24',
    from_node: 'V3ProviderActionPermitInFlight',
    to_node: 'V3ProviderActionPermitAbandonRequested',
    caller_symbol: 'execute_v3_responses_direct_runtime_kernel_core',
    caller_file: files.direct,
    callee_symbol: 'V3ProviderActionPermit::drop',
    callee_file: files.gate,
    call_witness: /\bdrop\s*\(\s*provider_action_permit\.take\(\)\s*\)/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-25',
    from_node: 'V3ProviderActionPermitInFlight',
    to_node: 'V3ProviderActionPermitAbandonRequested',
    caller_symbol: 'execute_v3_responses_relay_runtime_inner',
    caller_file: files.responses,
    callee_symbol: 'V3ProviderActionPermit::drop',
    callee_file: files.gate,
    call_witness: /\bdrop\s*\(\s*_provider_action_permit\.take\(\)\s*\)/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-26',
    from_node: 'V3ProviderActionPermitInFlight',
    to_node: 'V3ProviderActionPermitAbandonRequested',
    caller_symbol: 'execute_v3_anthropic_relay_runtime_inner',
    caller_file: files.anthropic,
    callee_symbol: 'V3ProviderActionPermit::drop',
    callee_file: files.gate,
    call_witness: /\bdrop\s*\(\s*_provider_action_permit\.take\(\)\s*\)/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-27',
    from_node: 'V3ProviderActionPermitInFlight',
    to_node: 'V3ProviderActionPermitAbandonRequested',
    caller_symbol: 'execute_v3_openai_chat_relay_runtime_inner',
    caller_file: files.openaiChat,
    callee_symbol: 'V3ProviderActionPermit::drop',
    callee_file: files.gate,
    call_witness: /\bdrop\s*\(\s*provider_action_permit\.take\(\)\s*\)/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-28',
    from_node: 'V3ProviderActionPermitInFlight',
    to_node: 'V3ProviderActionPermitAbandonRequested',
    caller_symbol: 'execute_v3_gemini_relay_runtime_inner',
    caller_file: files.gemini,
    callee_symbol: 'V3ProviderActionPermit::drop',
    callee_file: files.gate,
    call_witness: /\bdrop\s*\(\s*provider_action_permit\.take\(\)\s*\)/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-29',
    from_node: 'V3ProviderActionPermitInFlight',
    to_node: 'V3ProviderActionPermitAbandonRequested',
    caller_symbol: 'V3DirectSseProviderOutcome::record_failure',
    caller_file: files.directSse,
    callee_symbol: 'V3ProviderActionPermit::drop',
    callee_file: files.gate,
    call_witness: /\bdrop\s*\(\s*self\._provider_action_permit\.take\(\)\s*\)/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-30',
    from_node: 'V3ProviderActionPermitInFlight',
    to_node: 'V3ProviderActionPermitAbandonRequested',
    caller_symbol: 'V3OpenAiChatSseProviderOutcome::record_failure',
    caller_file: files.openaiChat,
    callee_symbol: 'V3ProviderActionPermit::drop',
    callee_file: files.gate,
    call_witness: /\bdrop\s*\(\s*self\._provider_action_permit\.take\(\)\s*\)/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-31',
    from_node: 'V3ProviderActionPermitInFlight',
    to_node: 'V3ProviderActionPermitAbandonRequested',
    caller_symbol: 'V3GeminiSseProviderOutcome::record_failure',
    caller_file: files.gemini,
    callee_symbol: 'V3ProviderActionPermit::drop',
    callee_file: files.gate,
    call_witness: /\bdrop\s*\(\s*self\._provider_action_permit\.take\(\)\s*\)/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-32',
    from_node: 'V3ProviderActionPermitAbandonRequested',
    to_node: 'V3ProviderActionPermitAbandoned',
    caller_symbol: 'V3ProviderActionPermit::drop',
    caller_file: files.gate,
    callee_symbol: 'V3ProviderActionGate::abandon_admission',
    callee_file: files.gate,
    call_witness: /\bself\s*\.\s*gate\s*\.\s*abandon_admission\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-33',
    from_node: 'V3ProviderActionPermitInFlight',
    to_node: 'V3ProviderActionSuccessObserved',
    caller_symbol: 'wrap_direct_sse_provider_outcome_stream',
    caller_file: files.directSse,
    callee_symbol: 'V3DirectSseProviderOutcome::record_success',
    callee_file: files.directSse,
    call_witness: /\bstate\s*\.\s*provider_outcome\s*\.\s*record_success\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-34',
    from_node: 'V3ProviderActionSuccessObserved',
    to_node: 'V3ProviderActionSuccessRecorded',
    caller_symbol: 'V3DirectSseProviderOutcome::record_success',
    caller_file: files.directSse,
    callee_symbol: 'V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope',
    callee_file: files.policy,
    call_witness: /\bself\s*\.\s*provider_health\s*\.\s*record_provider_success_in_failure_scope\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-35',
    from_node: 'V3ProviderActionPermitInFlight',
    to_node: 'V3ProviderActionFailureObserved',
    caller_symbol: 'wrap_direct_sse_provider_outcome_stream',
    caller_file: files.directSse,
    callee_symbol: 'V3DirectSseProviderOutcome::record_failure',
    callee_file: files.directSse,
    call_witness: /\bstate\s*\.\s*provider_outcome\s*\.\s*record_failure\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-36',
    from_node: 'V3ProviderActionPermitAbandoned',
    to_node: 'V3ProviderActionFailureRecorded',
    caller_symbol: 'V3DirectSseProviderOutcome::record_failure',
    caller_file: files.directSse,
    callee_symbol: 'V3ProviderFailureRuntimeHealth::record_post_commit_provider_stream_failure',
    callee_file: files.policy,
    call_witness: /\bself\s*\.\s*provider_health\s*\.\s*record_post_commit_provider_stream_failure\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-37',
    from_node: 'V3ProviderActionPermitInFlight',
    to_node: 'V3ProviderActionSuccessObserved',
    caller_symbol: 'project_sse_stream',
    caller_file: files.openaiChat,
    callee_symbol: 'V3OpenAiChatSseProviderOutcome::record_success',
    callee_file: files.openaiChat,
    call_witness: /\bstate\s*\.\s*provider_outcome\s*\.\s*record_success\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-38',
    from_node: 'V3ProviderActionSuccessObserved',
    to_node: 'V3ProviderActionSuccessRecorded',
    caller_symbol: 'V3OpenAiChatSseProviderOutcome::record_success',
    caller_file: files.openaiChat,
    callee_symbol: 'V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope',
    callee_file: files.policy,
    call_witness: /\bself\s*\.\s*provider_health\s*\.\s*record_provider_success_in_failure_scope\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-39',
    from_node: 'V3ProviderActionPermitInFlight',
    to_node: 'V3ProviderActionFailureObserved',
    caller_symbol: 'project_sse_stream',
    caller_file: files.openaiChat,
    callee_symbol: 'V3OpenAiChatSseProviderOutcome::record_failure',
    callee_file: files.openaiChat,
    call_witness: /\bstate\s*\.\s*provider_outcome\s*\.\s*record_failure\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-40',
    from_node: 'V3ProviderActionPermitAbandoned',
    to_node: 'V3ProviderActionFailureRecorded',
    caller_symbol: 'V3OpenAiChatSseProviderOutcome::record_failure',
    caller_file: files.openaiChat,
    callee_symbol: 'V3ProviderFailureRuntimeHealth::record_post_commit_provider_stream_failure',
    callee_file: files.policy,
    call_witness: /\bself\s*\.\s*provider_health\s*\.\s*record_post_commit_provider_stream_failure\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-41',
    from_node: 'V3ProviderActionPermitInFlight',
    to_node: 'V3ProviderActionSuccessObserved',
    caller_symbol: 'project_sse_stream',
    caller_file: files.gemini,
    callee_symbol: 'V3GeminiSseProviderOutcome::record_success',
    callee_file: files.gemini,
    call_witness: /\bstate\s*\.\s*provider_outcome\s*\.\s*record_success\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-42',
    from_node: 'V3ProviderActionSuccessObserved',
    to_node: 'V3ProviderActionSuccessRecorded',
    caller_symbol: 'V3GeminiSseProviderOutcome::record_success',
    caller_file: files.gemini,
    callee_symbol: 'V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope',
    callee_file: files.policy,
    call_witness: /\bself\s*\.\s*provider_health\s*\.\s*record_provider_success_in_failure_scope\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-43',
    from_node: 'V3ProviderActionPermitInFlight',
    to_node: 'V3ProviderActionFailureObserved',
    caller_symbol: 'project_sse_stream',
    caller_file: files.gemini,
    callee_symbol: 'V3GeminiSseProviderOutcome::record_failure',
    callee_file: files.gemini,
    call_witness: /\bstate\s*\.\s*provider_outcome\s*\.\s*record_failure\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-44',
    from_node: 'V3ProviderActionPermitAbandoned',
    to_node: 'V3ProviderActionFailureRecorded',
    caller_symbol: 'V3GeminiSseProviderOutcome::record_failure',
    caller_file: files.gemini,
    callee_symbol: 'V3ProviderFailureRuntimeHealth::record_post_commit_provider_stream_failure',
    callee_file: files.policy,
    call_witness: /\bself\s*\.\s*provider_health\s*\.\s*record_post_commit_provider_stream_failure\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-45',
    from_node: 'V3ProviderActionPermitInFlight',
    to_node: 'V3ProviderActionSuccessRecorded',
    caller_symbol: 'execute_v3_responses_relay_runtime_inner',
    caller_file: files.responses,
    callee_symbol: 'V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope',
    callee_file: files.policy,
    call_witness: /\bprovider_health\s*\.\s*record_provider_success_in_failure_scope\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-46',
    from_node: 'V3ProviderActionPermitInFlight',
    to_node: 'V3ProviderActionSuccessFinalize',
    caller_symbol: 'execute_v3_anthropic_relay_runtime_inner',
    caller_file: files.anthropic,
    callee_symbol: 'record_provider_success_after_resp04',
    callee_file: files.anthropic,
    call_witness: /\brecord_provider_success_after_resp04\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-47',
    from_node: 'V3ProviderActionSuccessFinalize',
    to_node: 'V3ProviderActionSuccessRecorded',
    caller_symbol: 'record_provider_success_after_resp04',
    caller_file: files.anthropic,
    callee_symbol: 'V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope',
    callee_file: files.policy,
    call_witness: /\bprovider_health\s*\.\s*record_provider_success_in_failure_scope\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-48',
    from_node: 'V3ProviderRespInbound01Raw',
    to_node: 'V3ProviderResponsesEventCodec',
    caller_symbol: 'wrap_direct_sse_provider_outcome_stream',
    caller_file: files.directSse,
    callee_symbol: 'V3DirectSseProviderOutcome::observe_chunk',
    callee_file: files.directSse,
    call_witness: /\bstate\s*\.\s*provider_outcome\s*\.\s*observe_chunk\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-49',
    from_node: 'V3ProviderResponsesEventCodec',
    to_node: 'V3ProviderResponsesTerminalOrFailureObserved',
    caller_symbol: 'V3DirectSseProviderOutcome::observe_chunk',
    caller_file: files.directSse,
    callee_symbol: 'V3DirectSseProviderOutcome::observe_frame',
    callee_file: files.directSse,
    call_witness: /\bself\s*\.\s*observe_frame\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-50',
    from_node: 'V3ProviderRespInbound01Raw',
    to_node: 'V3ProviderResponsesEventCodec',
    caller_symbol: 'build_v3_hub_resp_inbound_02_from_responses_provider_stream_events',
    caller_file: files.responsesMaterializer,
    callee_symbol: 'observe_v3_runtime_responses_sse_transport_chunk',
    callee_file: files.responsesCodec,
    call_witness: /\bobserve_v3_runtime_responses_sse_transport_chunk\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
  {
    step_id: 'v3-provider-action-gate-51',
    from_node: 'V3ProviderResponsesEventCodec',
    to_node: 'V3ProviderResponsesTerminalOrFailureObserved',
    caller_symbol: 'observe_v3_runtime_responses_sse_transport_chunk',
    caller_file: files.responsesCodec,
    callee_symbol: 'apply_v3_runtime_responses_semantic_event',
    callee_file: files.responsesCodec,
    call_witness: /\bapply_v3_runtime_responses_semantic_event\s*\(/u,
    status: 'anchored',
    owner_feature_id: 'v3.provider_action_gate',
  },
];

function verifyEdgeContract({ mapDoc, manifestDoc, chainId, requiredEdges, mapRel, manifestRel, v3 }) {
  const chain = asArray(mapDoc?.chains).find((row) => row?.chain_id === chainId);
  if (!chain) {
    failures.push(`${mapRel}: missing required chain ${chainId}`);
    return;
  }
  const mapEdges = asArray(chain.edges);
  if (mapEdges.length !== requiredEdges.length) {
    failures.push(`${mapRel}: ${chainId} must contain exactly ${requiredEdges.length} edges`);
  }
  const duplicateMapIds = mapEdges
    .map((edge) => edge?.step_id)
    .filter((stepId, index, all) => all.indexOf(stepId) !== index);
  if (duplicateMapIds.length > 0) {
    failures.push(`${mapRel}: duplicate edge IDs: ${[...new Set(duplicateMapIds)].join(', ')}`);
  }
  const mapIds = new Set(mapEdges.map((edge) => edge?.step_id));
  const requiredIds = new Set(requiredEdges.map((edge) => edge.step_id));
  for (const stepId of requiredIds) {
    if (!mapIds.has(stepId)) failures.push(`${mapRel}: missing required edge ${stepId}`);
  }
  for (const stepId of mapIds) {
    if (!requiredIds.has(stepId)) failures.push(`${mapRel}: unexpected edge ${stepId} in ${chainId}`);
  }
  const manifestEdges = asArray(manifestDoc?.edges);
  if (manifestEdges.length !== requiredEdges.length) {
    failures.push(`${manifestRel}: must contain exactly ${requiredEdges.length} edges`);
  }
  const duplicateManifestIds = manifestEdges
    .map((edge) => edge?.step_id)
    .filter((stepId, index, all) => all.indexOf(stepId) !== index);
  if (duplicateManifestIds.length > 0) {
    failures.push(
      `${manifestRel}: duplicate edge IDs: ${[...new Set(duplicateManifestIds)].join(', ')}`,
    );
  }
  const manifestIds = new Set(manifestEdges.map((edge) => edge?.step_id));
  for (const stepId of requiredIds) {
    if (!manifestIds.has(stepId)) failures.push(`${manifestRel}: missing required edge ${stepId}`);
  }
  for (const stepId of manifestIds) {
    if (!requiredIds.has(stepId)) failures.push(`${manifestRel}: unexpected edge ${stepId}`);
  }

  for (const required of requiredEdges) {
    const mapEdge = mapEdges.find((edge) => edge?.step_id === required.step_id);
    const manifestEdge = manifestEdges.find((edge) => edge?.step_id === required.step_id);
    if (!mapEdge || !manifestEdge) continue;
    for (const field of [
      'caller_symbol',
      'caller_file',
      'callee_symbol',
      'callee_file',
      'status',
      'owner_feature_id',
    ]) {
      if (mapEdge[field] !== required[field]) {
        failures.push(`${mapRel}: ${required.step_id}.${field} must equal ${required[field]}`);
      }
      if (manifestEdge[field] !== mapEdge[field]) {
        failures.push(`${manifestRel}: ${required.step_id}.${field} is out of sync with ${mapRel}`);
      }
    }
    const mapFrom = mapEdge.from_node;
    const mapTo = mapEdge.to_node;
    const manifestFrom = v3 ? manifestEdge.from : manifestEdge.from_node;
    const manifestTo = v3 ? manifestEdge.to : manifestEdge.to_node;
    if (mapFrom !== required.from_node || mapTo !== required.to_node) {
      failures.push(
        `${mapRel}: ${required.step_id} endpoints must be ${required.from_node} -> ${required.to_node}`,
      );
    }
    if (manifestFrom !== mapFrom || manifestTo !== mapTo) {
      failures.push(`${manifestRel}: ${required.step_id} endpoints are out of sync with ${mapRel}`);
    }
    assertCallerInvokesCallee(required);
  }
}

for (const rel of Object.values(files)) {
  if (!fs.existsSync(abs(rel))) failures.push(`${rel}: missing required file`);
}
const text = Object.fromEntries(Object.entries(files).map(([key, rel]) => [key, read(rel)]));

for (const token of [
  'target_protocol_unmapped_field_fails_without_provider_switch_or_transport',
  '"ProviderReqCompat06ProviderCompat"',
  '"provider_request_compat_error"',
  '"V3ProviderReqOutbound08WirePayload"',
  '"provider_request_wire_error"',
]) {
  requireText(text.responses, files.responses, token);
}
const responsesRelayRequestBody = findFunctionBody(
  text.responses,
  'execute_v3_responses_relay_runtime_inner',
  files.responses,
);
for (const [label, pattern] of [
  [
    'ProviderReqCompat06ProviderCompat request-local fail-fast branch',
    /let\s+req_compat\s*=\s*try_before_resp03!\s*\(\s*build_provider_req_compat_06_from_v3_hub_req_outbound_07\s*\(req07\)\s*\)\s*;/u,
  ],
  [
    'V3ProviderReqOutbound08WirePayload failure branch',
    /let\s+wire\s*=\s*match\s+build_v3_provider_12_responses_wire_payload\s*\([\s\S]{0,1200}?\)\s*\{[\s\S]{0,1200}?Err\s*\(\s*error\s*\)\s*=>\s*\{\s*handle_provider_request_failure!\s*\(\s*V3ResponsesRelayRuntimeError::Provider\s*\(\s*error\s*\)\s*\)\s*;/u,
  ],
]) {
  if (!pattern.test(responsesRelayRequestBody)) {
    failures.push(
      label.startsWith('V3ProviderReqOutbound08WirePayload')
        ? `${files.responses}: ${label} must enter handle_provider_request_failure`
        : `${files.responses}: ${label} is missing`,
    );
  }
}
for (const forbidden of [
  'provider_compat_error_is_target_protocol_incompatible',
  'target_protocol_incompatible_candidates',
  'last_target_protocol_incompatible_error',
]) {
  if (responsesRelayRequestBody.includes(forbidden)) {
    failures.push(`${files.responses}: ProviderReqCompat06ProviderCompat must not switch provider through ${forbidden}`);
  }
}
assertCallerInvokesCallee({
  step_id: 'v3-provider-action-gate-responses-policy-ingress',
  caller_symbol: 'handle_v3_responses_relay_provider_failure',
  caller_file: files.responses,
  callee_symbol: 'run_v3_relay_provider_failure_policy',
  callee_file: files.policy,
});
const responsesRelayFailureHandlerBody = findFunctionBody(
  text.responses,
  'handle_v3_responses_relay_provider_failure',
  files.responses,
);
if (
  !/^\{\s*if\s+failure\.terminal_projection\.is_some\(\)\s*\{\s*return\s+Ok\(Some\(failure\)\);\s*\}\s*let\s+result\s*=\s*run_v3_relay_provider_failure_policy\s*\(/u
    .test(responsesRelayFailureHandlerBody)
) {
  failures.push(
    `${files.responses}: handle_v3_responses_relay_provider_failure must enter run_v3_relay_provider_failure_policy immediately after its existing terminal projection guard`,
  );
}

for (const token of [
  'PROVIDER_ACTION_ISOLATED_DELAY_MS: u64 = 1_000',
  'PROVIDER_ACTION_SUSTAINED_DELAY_MS: u64 = 5_000',
  'pub fn commit_terminal(',
  'pub fn record_success(',
  'pub fn abandon_admission(',
  'admitted_action_scope: Option<String>',
  'admitted_action_requires_explicit_abandon_before_replacement_generation',
  'stale_action_scope_cannot_abandon_or_commit_a_reused_generation',
  'unrelated_success_cannot_release_an_active_action_scope',
  'waiter_ticket_rejects_action_scope_rebinding',
]) {
  requireText(text.v2Gate, files.v2Gate, token);
}
requireText(
  text.v2Gate,
  files.v2Gate,
  'state.next_admission_at = now + Duration::from_millis(PROVIDER_ACTION_SUSTAINED_DELAY_MS);',
);
requireOccurrenceCount(
  text.v2Gate,
  files.v2Gate,
  'state.admitted_action_scope.as_deref() != Some(action_scope_key.as_str())',
  2,
);
requireOccurrenceCount(
  text.v2Gate,
  files.v2Gate,
  'ticket.action_scope_key != action_scope_key',
  2,
);
for (const token of [
  'terminalProjection?: boolean',
  'commitProviderActionTerminalNative(',
  'recordProviderActionSuccessNative(',
  'abandonProviderActionAdmissionNative(',
  'throwIfClientAbortSignalAborted(args.signal)',
  "registration.signal.removeEventListener('abort', registration.onAbort)",
  "terminalProjection: retryExecutionPlan.action === 'project_terminal'",
]) {
  requireText(`${text.v2Queue}\n${text.v2Plan}`, `${files.v2Queue} + ${files.v2Plan}`, token);
}

for (const token of [
  'pub const V3_PROVIDER_ACTION_ISOLATED_DELAY_MS: u64 = 1_000;',
  'pub const V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS: u64 = 5_000;',
  'pub fn process_shared() -> Self',
  'static SHARED: OnceLock<V3ProviderActionGate>',
  'pub(crate) struct V3ProviderActionPermit',
  'impl Drop for V3ProviderActionPermit',
  'self.gate.abandon_admission(&self.key, self.generation)',
  'waiter_queue: VecDeque<u64>',
  'state.waiter_queue.len() > 1',
  'state.admitted_generation == Some(state.generation)',
  'let active_admission_owned = states.iter().any',
  'if !active_admission_owned {',
  'let group_has_active_admission = states.iter().any',
  '(!self.admit_action || !group_has_active_admission)',
  'record_failure_and_wait_for_terminal_projection',
  'pub async fn wait_for_exact_provider_action(',
  'pub fn abandon_admission(',
  'pub fn commit_terminal_admission(',
  'V3ProviderActionRecoveryTransition',
  'state.next_admission_at =\n                            now + Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS);',
]) {
  requireText(text.gate, files.gate, token);
}
requireText(text.gate, files.gate, 'active_lane_generation');
const recordProviderSuccessBody = findFunctionBody(
  text.gate,
  'V3ProviderActionGate::record_provider_success',
  files.gate,
);
if (
  !/key\.provider_scope\s*==\s*\*provider_scope\s*\|\|\s*state\.admitted_action_scope\.as_ref\(\)\s*==\s*Some\(provider_scope\)/u
    .test(recordProviderSuccessBody)
) {
  failures.push(
    `${files.gate}: provider success may release only its exact provider scope or the permit-owned action scope`,
  );
}
for (const forbidden of [
  'provider action gate state disappeared without an explicit transition',
  'provider action gate notification channel closed without an explicit transition',
]) {
  requireText(text.gate, files.gate, forbidden);
}
if (
  /generation:\s*0,[\s\S]{0,180}?released_by_success:\s*true/u.test(text.gate)
) {
  failures.push(
    `${files.gate}: missing state or notification closure must not be wrapped as provider success`,
  );
}
if (
  text.gate.includes(
    'state.admitted_generation == Some(state.generation)\n                    && now >= state.next_admission_at',
  )
) {
  failures.push(
    `${files.gate}: admitted provider action must not expire from wall-clock time while its permit is owned`,
  );
}
if (
  !/ReleasedBySuccess\s*\(\s*V3ProviderActionRecoveryTicket\s*\)/u.test(text.gate)
) {
  failures.push(
    `${files.gate}: success-released recovery transition must carry the exact retained recovery ticket`,
  );
}

for (const token of [
  'pub struct V3Error05RecoveryAdmissionWitness',
  'pub enum V3Error05ExecutionAction',
  'WaitThenRetrySame',
  'WaitThenReselect',
  'ProjectTerminal',
  'pub struct V3Error05TerminalDecision',
  'pub fn try_into_terminal',
  'terminal: V3Error05TerminalDecision',
]) {
  requireText(text.error, files.error, token);
}
if (
  !/pub\s+struct\s+V3Error05RecoveryAdmissionWitness\s*\{[^}]*\bgeneration:\s*u64,/u
    .test(text.error)
) {
  failures.push(
    `${files.error}: V3Error05RecoveryAdmissionWitness missing generation: u64`,
  );
}
for (const testName of [
  'classifier_failure_preserves_its_own_error01_stage_and_code',
  'route_plan_failure_preserves_its_own_error01_stage_and_code',
  'candidate_expansion_failure_preserves_its_own_error01_stage_and_code',
  'unavailable_candidate_is_exhaustion_not_runtime_failure',
  'target_resolution_failure_projects_itself_instead_of_prior_provider_429',
]) {
  assertRustTest(text.policyTests, files.policyTests, testName);
}
if (/pub\s+struct\s+V3Error05TerminalDecision\s*\{\s*pub/gu.test(text.error)) {
  failures.push(`${files.error}: terminal Error05 wrapper must not expose constructible fields`);
}

for (const [name, source, rel] of [
  ['Direct', text.direct, files.direct],
  ['Responses Relay', text.responses, files.responses],
  ['OpenAI Chat Relay', text.openaiChat, files.openaiChat],
  ['Anthropic Relay', text.anthropic, files.anthropic],
  ['Gemini Relay', text.gemini, files.gemini],
]) {
  requireText(source, rel, 'wait_for_error05_recovery');
  requireText(source, rel, 'V3ProviderActionGateAdmission');
  requireText(source, rel, 'V3ProviderActionRecoveryTransition::Superseded');
  requireText(source, rel, 'V3ProviderActionRecoveryTransition::ReleasedBySuccess');
  requireText(source, rel, 'V3ProviderActionGateTerminalReevaluation');
  const successReleaseRearm =
    /V3ProviderActionRecoveryTransition::ReleasedBySuccess\(ticket\)[\s\S]{0,80}?=>\s*\{[\s\S]{0,480}?pending_provider_action_recovery\s*=[\s\S]{0,220}?ticket[\s\S]{0,120}?recovery_witness\(\)/u;
  if (!successReleaseRearm.test(source)) {
    failures.push(
      `${rel}: ${name} must re-arm the exact retained recovery ticket after provider success releases a queued waiter`,
    );
  }
  if (!source.includes('V3Error05ExecutionAction')) {
    failures.push(`${rel}: ${name} must consume typed Error05 actions`);
  }
  requireText(source, rel, 'let mut pending_provider_action_recovery = None;');
  const recoveryOnlyWait = /if\s+let\s+Some\(recovery\)\s*=\s*pending_provider_action_recovery\.take\(\)\s*\{[\s\S]{0,700}?wait_for_error05_recovery/u;
  if (!recoveryOnlyWait.test(source)) {
    failures.push(
      `${rel}: ${name} must wait on the provider action gate only after the current request enters Error05 recovery`,
    );
  }
  if (source.includes('pending_provider_action_gate')) {
    failures.push(`${rel}: ${name} must not retain bool-only provider action recovery state`);
  }
  if (source.includes('wait_for_selected_provider_action')) {
    failures.push(`${rel}: ${name} must not select a recovery lane by latest routing-group state`);
  }
}
requireText(text.direct, files.direct, 'let mut continuation_provider_action_lookup = previous_response_id.is_some();');
requireText(text.direct, files.direct, 'wait_for_exact_selected_provider_action');
requireText(text.directSse, files.directSse, 'if event_type == "response.completed" {');
if (/matches!\s*\(\s*[\w.]+\s*,\s*"response\.completed"\s*\|\s*"response\.done"/u.test(text.directSse)) {
  failures.push(
    `${files.directSse}: provider response.done must not satisfy the response.completed terminal contract`,
  );
}
requireText(text.directHelpers, files.directHelpers, 'if semantic_event != "response.completed" {');
if (/semantic_event[\s\S]{0,160}?"response\.completed"\s*\|\s*"response\.done"/u.test(text.directHelpers)) {
  failures.push(
    `${files.directHelpers}: Direct Stopless provider semantic hooks must not accept response.done before response.completed closeout`,
  );
}
requireText(text.policy, files.policy, 'V3RelayProviderTargetResolution::Exhausted');
if (text.policy.includes('if let Ok(alternative) = resolve_v3_relay_target')) {
  failures.push(
    `${files.policy}: target-resolution source errors must not be swallowed as provider-pool exhaustion`,
  );
}
for (const token of [
  'V3ProviderActionRecoveryTicket',
  'V3ProviderActionRecoveryTransition',
  'wait_for_recovery_ticket',
  'recovery_ticket',
]) {
  requireText(text.gate, files.gate, token);
}
requireText(
  text.responses,
  files.responses,
  'Some("response.completed") => Some("completed".to_string()),',
);
requireText(
  text.responsesCodec,
  files.responsesCodec,
  'Some("response.completed") => {',
);
for (const forbidden of [
  'Some("response.completed" | "response.done")',
  'Some("response.completed" | "response.done" | "response.requires_action")',
]) {
  if (text.responses.includes(forbidden) || text.responsesCodec.includes(forbidden)) {
    failures.push(
      `${files.responses} + ${files.responsesCodec}: provider response.done/response.requires_action must not satisfy the response.completed terminal contract`,
    );
  }
}
requireOccurrenceCount(text.direct, files.direct, 'drop(provider_action_permit.take());', 3);
requireOccurrenceCount(
  text.directSse,
  files.directSse,
  'drop(self._provider_action_permit.take());',
  1,
);
requireOccurrenceCount(
  text.responses,
  files.responses,
  'drop(_provider_action_permit.take());',
  9,
);
requireOccurrenceCount(
  text.openaiChat,
  files.openaiChat,
  'drop(provider_action_permit.take());',
  4,
);
requireOccurrenceCount(
  text.openaiChat,
  files.openaiChat,
  'drop(self._provider_action_permit.take());',
  1,
);
requireOccurrenceCount(
  text.anthropic,
  files.anthropic,
  'drop(_provider_action_permit.take());',
  7,
);
requireOccurrenceCount(
  text.gemini,
  files.gemini,
  'drop(provider_action_permit.take());',
  4,
);
requireOccurrenceCount(
  text.gemini,
  files.gemini,
  'drop(self._provider_action_permit.take());',
  1,
);
for (const [name, source, rel] of [
  ['OpenAI Chat Relay', text.openaiChat, files.openaiChat],
  ['Anthropic Relay', text.anthropic, files.anthropic],
  ['Gemini Relay', text.gemini, files.gemini],
]) {
  requireText(source, rel, 'provider_request_failure');
  requireText(source, rel, 'handle_provider_request_failure');
  if (/build_provider_req_compat_06_from_v3_hub_req_outbound_07\(req07\)\?/u.test(source)) {
    failures.push(`${rel}: ${name} provider compat failure bypasses typed Error05`);
  }
}
for (const token of [
  'action_gate: V3ProviderActionGate::process_shared()',
  'project_v3_client_disconnect',
  'record_provider_action_failure',
  'wait_for_terminal_provider_projection',
  'build_v3_relay_provider_error_05_decision',
  'terminal_projection_for',
  'provider_runtime_failure_stage',
]) {
  requireText(text.policy, files.policy, token);
}
for (const forbidden of [
  'V3RelayProviderFailureDecision',
  'V3DirectProviderFailureDecision',
  'retry_delay_ms',
  'default_floor_delay_ms_for_retry',
  'V3_PROVIDER_FAILURE_BACKOFF_DELAY_MS',
  'target_local_reselect")',
]) {
  const production = [
    text.policy,
    text.direct,
    text.directHelpers,
    text.responses,
    text.openaiChat,
    text.anthropic,
    text.gemini,
  ].join('\n');
  if (production.includes(forbidden)) failures.push(`V3 provider action path contains forbidden legacy token ${forbidden}`);
}

const requiredGateTests = [
  'isolated_failure_blocks_one_action_for_at_least_one_second',
  'isolated_terminal_projection_waits_for_the_same_one_second_gate',
  'unrelated_success_cannot_release_a_stale_terminal_projection',
  'overlapping_waiter_promotes_scope_to_five_seconds_and_one_admission',
  'process_shared_handles_observe_the_same_cross_request_generation',
  'terminal_transition_wakes_old_waiter_for_reselection_then_serializes_next_generation',
  'changing_provider_and_error_family_cannot_restart_an_active_lane_at_one_second',
  'admitted_action_requires_explicit_drop_before_replacement_generation',
  'unrelated_same_group_provider_success_cannot_release_an_owned_action_permit',
  'fifo_waiter_cancellation_removes_only_its_ticket',
  'success_released_recovery_reenters_the_retained_five_second_generation',
];
for (const testName of requiredGateTests) {
  assertRustTest(text.gateTests, files.gateTests, testName);
}
for (const token of [
  'post_commit_sse_failure_records_failure_but_does_not_block_a_fresh_request',
  'terminal_sse_recovery_does_not_block_a_fresh_request',
  'active_recovery_sse_blocks_a_second_recovery_beyond_five_seconds',
]) {
  assertRustTest(text.openaiChatTests, files.openaiChatTests, token);
  assertRustTest(text.geminiTests, files.geminiTests, token);
}
assertRustTest(
  text.openaiChatTests,
  files.openaiChatTests,
  'provider_error_enters_error01_06_without_success_projection',
);
assertRustTest(
  text.geminiTests,
  files.geminiTests,
  'provider_error_enters_error01_06_without_success_projection',
);
assertRustTest(
  text.responsesRelayTests,
  files.responsesRelayTests,
  'responses_relay_terminal_missing_fails_explicitly_but_fresh_request_bypasses_recovery',
);
for (const token of [
  'provider_sse_done_without_completed_is_terminal_missing',
  'provider_sse_requires_action_without_completed_is_terminal_missing',
]) {
  assertRustTest(text.responses, files.responses, token);
}
for (const token of [
  'direct_post_commit_malformed_sse_records_failure_but_fresh_request_bypasses_recovery',
  'direct_post_commit_response_failed_records_failure_but_fresh_request_bypasses_recovery',
  'direct_terminal_sse_recovery_does_not_block_a_fresh_request',
]) {
  assertRustTest(text.directSseTests, files.directSseTests, token);
}
assertRustTest(
  text.directTests,
  files.directTests,
  'direct_client_disconnect_is_health_neutral_and_never_enters_action_wait',
);
assertRustTest(
  text.directUnitTests,
  files.directUnitTests,
  'normal_direct_request_does_not_consume_unrelated_provider_failure_gate',
);
requireText(
  text.directHelpers,
  files.directHelpers,
  'if matches!(source.source_kind, V3ErrorSourceKind::ClientDisconnect)',
);
for (const token of [
  'V3ExactPinAvailabilityExhaustion',
  'continuation_exact_pin_unavailable',
]) {
  requireText(text.directHelpers, files.directHelpers, token);
}
requireText(
  text.directExactPinTests,
  files.directExactPinTests,
  'missing_exact_pin_is_provider_availability_error05_without_router_reentry',
);
for (const token of [
  'provider_failure_with_route_capacity_is_typed_nonterminal_error05',
  'provider_failure_with_same_provider_budget_is_typed_retry_same',
  'provider_failure_projects_only_with_route_and_default_exhaustion_proof',
]) {
  assertRustTest(text.errorTests, files.errorTests, token);
}
requireText(
  text.error,
  files.error,
  'provider failure projection requires caller-owned route/default availability proof',
);
for (const token of [
  'direct_sse_console_closeout_abruptly_closes_without_fabricating_error06',
  'relay_sse_body_abruptly_closes_without_fabricating_error_event',
]) {
  requireText(text.serverTests, files.serverTests, token);
}
for (const token of [
  'emit_v3_post_commit_sse_source_console_line_for_context',
  'io::Error::other',
]) {
  requireText(text.server, files.server, token);
}

const v2FunctionMap = parseYaml(files.v2FunctionMap);
const v2ResourceMap = parseYaml(files.v2ResourceMap);
const v2MainlineMap = parseYaml(files.v2MainlineMap);
const v2VerificationMap = parseYaml(files.v2VerificationMap);
const v2BindingBudget = parseYaml(files.v2BindingBudget);
const v2Manifest = parseYaml(files.v2Manifest);
const functionMap = parseYaml(files.functionMap);
const resourceMap = parseYaml(files.resourceMap);
const mainlineMap = parseYaml(files.mainlineMap);
const verificationMap = parseYaml(files.verificationMap);
const manifest = parseYaml(files.manifest);

verifyEdgeContract({
  mapDoc: v2MainlineMap,
  manifestDoc: v2Manifest,
  chainId: 'error.provider_action_gate.mainline',
  requiredEdges: requiredV2Edges,
  mapRel: files.v2MainlineMap,
  manifestRel: files.v2Manifest,
  v3: false,
});
verifyEdgeContract({
  mapDoc: mainlineMap,
  manifestDoc: manifest,
  chainId: 'v3.provider_action_gate.mainline',
  requiredEdges: requiredV3Edges,
  mapRel: files.mainlineMap,
  manifestRel: files.manifest,
  v3: true,
});
const requiredV2Nodes = [...new Set(
  requiredV2Edges.flatMap((edge) => [edge.from_node, edge.to_node]),
)];
const requiredV3Nodes = [...new Set(
  requiredV3Edges.flatMap((edge) => [edge.from_node, edge.to_node]),
)];
assertExactStrings(
  v2Manifest?.node_ids,
  requiredV2Nodes,
  `${files.v2Manifest}: node_ids`,
);
assertExactStrings(
  asArray(manifest?.nodes).map((node) => node?.node_id),
  requiredV3Nodes,
  `${files.manifest}: nodes`,
);
for (const [nodeId, owner] of [
  ['ProviderReqCompat06ProviderCompat', 'routecodex-v3-runtime'],
  ['V3ProviderReqOutbound08WirePayload', 'routecodex-v3-runtime'],
  ['V3Error01SourceRaised', 'routecodex-v3-error'],
  ['V3Error05ExecutionDecision', 'routecodex-v3-error'],
  ['V3Error05RecoveryWitness', 'routecodex-v3-error'],
  ['V3ProviderActionGateAdmission', 'routecodex-v3-runtime'],
  ['V3ExecutionRetryOrReselect', 'routecodex-v3-runtime'],
  ['V3ProviderActionGateTerminalAdmission', 'routecodex-v3-runtime'],
  ['V3ProviderActionGateTerminalCommitted', 'routecodex-v3-runtime'],
  ['V3ProviderActionPermitInFlight', 'routecodex-v3-runtime'],
  ['V3ProviderActionPermitAbandonRequested', 'routecodex-v3-runtime'],
  ['V3ProviderActionPermitAbandoned', 'routecodex-v3-runtime'],
  ['V3ProviderActionSuccessObserved', 'routecodex-v3-runtime'],
  ['V3ProviderActionFailureObserved', 'routecodex-v3-runtime'],
  ['V3ProviderActionSuccessFinalize', 'routecodex-v3-runtime'],
  ['V3ProviderActionSuccessRecorded', 'routecodex-v3-runtime'],
  ['V3ProviderActionFailureRecorded', 'routecodex-v3-runtime'],
  ['V3ProviderRespInbound01Raw', 'routecodex-v3-runtime'],
  ['V3ProviderResponsesEventCodec', 'routecodex-v3-runtime'],
  ['V3ProviderResponsesTerminalOrFailureObserved', 'routecodex-v3-runtime'],
]) {
  const node = asArray(manifest?.nodes).find((row) => row?.node_id === nodeId);
  if (node?.owner !== owner) {
    failures.push(`${files.manifest}: ${nodeId} owner must be ${owner}`);
  }
}
assertExactStrings(
  manifest?.resources,
  ['v3.error.execution_decision', 'v3.error.provider_action_gate', 'v3.provider.health_state'],
  `${files.manifest}: resources`,
);
assertExactStrings(
  manifest?.return_path,
  [
    'V3ExecutionRetryOrReselect',
    'V3ProviderActionGateTerminalCommitted',
    'V3ProviderActionSuccessRecorded',
    'V3ProviderActionFailureRecorded',
    'V3ProviderActionPermitAbandoned',
  ],
  `${files.manifest}: return_path`,
);

const v2Feature = asArray(v2FunctionMap.owners).find((row) => row?.feature_id === 'error.provider_action_gate');
const v2Verification = asArray(v2VerificationMap.verification).find(
  (row) => row?.feature_id === 'error.provider_action_gate',
);
const v2Resource = asArray(v2ResourceMap.resources).find(
  (row) => row?.resource_id === 'error.provider_action_gate',
);
const v2Budget = asArray(v2BindingBudget.chains).find(
  (row) => row?.chain_id === 'error.provider_action_gate.mainline',
);
const v2Chain = asArray(v2MainlineMap.chains).find(
  (row) => row?.chain_id === 'error.provider_action_gate.mainline',
);
const v3Chain = asArray(mainlineMap.chains).find(
  (row) => row?.chain_id === 'v3.provider_action_gate.mainline',
);
if (v2Feature?.status !== 'active') failures.push(`${files.v2FunctionMap}: V2 feature must be active`);
if (
  v2Feature?.owner_kind !== 'rust_ssot'
  || v2Feature?.owner_module !== files.v2Gate
) {
  failures.push(`${files.v2FunctionMap}: V2 feature owner must remain the Rust provider action gate`);
}
assertExactStrings(
  v2Feature?.mainline_bindings,
  requiredV2Edges.map((edge) => edge.step_id),
  `${files.v2FunctionMap}: error.provider_action_gate.mainline_bindings`,
);
assertIncludes(
  v2Feature?.resource_bindings?.writes,
  ['error.provider_action_gate@ProviderActionGateState'],
  `${files.v2FunctionMap}: error.provider_action_gate.resource_bindings.writes`,
);
assertIncludes(
  v2Feature?.canonical_builders,
  ['commit_terminal', 'record_success', 'abandon_admission'],
  `${files.v2FunctionMap}: error.provider_action_gate.canonical_builders`,
);
assertExactStrings(
  v2Verification?.mainline_bindings,
  requiredV2Edges.map((edge) => edge.step_id),
  `${files.v2VerificationMap}: error.provider_action_gate.mainline_bindings`,
);
assertIncludes(
  v2Verification?.contract,
  [files.v2FunctionMap, files.v2ResourceMap, files.v2MainlineMap, files.v2Manifest, files.v2Wiki],
  `${files.v2VerificationMap}: error.provider_action_gate.contract`,
);
if (v2Resource?.binding_status !== 'anchored') {
  failures.push(`${files.v2ResourceMap}: V2 provider action gate resource must be anchored`);
}
if (
  v2Resource?.resource_kind !== 'side_channel'
  || v2Resource?.owner_node !== 'ProviderActionGateState'
  || v2Resource?.lifecycle !== 'error.provider_action_gate.mainline'
  || v2Resource?.owner_feature_id !== 'error.provider_action_gate'
  || v2Chain?.owner_feature_id !== 'error.provider_action_gate'
  || v2Manifest?.lifecycle_id !== 'error.provider_action_gate.mainline'
  || v2Manifest?.owner_feature_id !== 'error.provider_action_gate'
  || v2Manifest?.entrypoint?.call_map_chain_id !== 'error.provider_action_gate.mainline'
) {
  failures.push(
    `${files.v2ResourceMap} + ${files.v2MainlineMap} + ${files.v2Manifest}: V2 lifecycle/chain/owner binding drift`,
  );
}
if (
  v2Manifest?.downstream_projection?.lifecycle_id !== 'error.mainline'
  || v2Manifest?.downstream_projection?.step_id !== 'err-05'
  || v2Manifest?.downstream_projection?.provider_action_gate_witness !== 'none'
) {
  failures.push(`${files.v2Manifest}: downstream Error06 projection reference must remain error.mainline#err-05 with no gate witness`);
}
if (asArray(v2Resource?.allowed_readers).includes('resolveReportedRouteErrorHttpResponse')) {
  failures.push(`${files.v2ResourceMap}: Error06 projector must not claim to read provider action gate state`);
}
if (
  v2Budget?.expected_total_edges !== requiredV2Edges.length
  || v2Budget?.min_anchored_edges !== requiredV2Edges.length
  || v2Budget?.max_partial_edges !== 0
  || v2Budget?.max_binding_pending_edges !== 0
) {
  failures.push(
    `${files.v2BindingBudget}: error.provider_action_gate.mainline must lock ${requiredV2Edges.length} anchored edges with zero debt`,
  );
}
assertIncludes(
  v2Resource?.allowed_writers,
  ['commit_terminal', 'record_success', 'abandon_admission'],
  `${files.v2ResourceMap}: error.provider_action_gate.allowed_writers`,
);
if (
  v2Manifest?.admission_ownership?.wall_clock_expiry_forbidden !== true
  || v2Manifest?.admission_ownership?.abandon_increments_failure_count !== false
  || v2Manifest?.admission_ownership?.max_admissions_per_generation !== 1
) {
  failures.push(
    `${files.v2Manifest}: admission_ownership must lock explicit outcomes, no wall-clock expiry, and health-neutral abandon`,
  );
}
if (Object.hasOwn(v2Manifest, 'admission_lease')) {
  failures.push(`${files.v2Manifest}: disproved admission_lease contract must be physically removed`);
}

const feature = asArray(functionMap.features).find((row) => row?.feature_id === 'v3.provider_action_gate');
const verification = asArray(verificationMap.features).find(
  (row) => row?.feature_id === 'v3.provider_action_gate',
);
const resource = asArray(resourceMap.resources).find(
  (row) => row?.resource_id === 'v3.error.provider_action_gate',
);
if (feature?.status !== 'active' || feature?.runtime_status !== 'source_active_live_verification_required') {
  failures.push(`${files.functionMap}: v3.provider_action_gate must be active with live verification explicit`);
}
if (
  feature?.owner_crate !== 'routecodex-v3-runtime'
  || feature?.owner_file !== files.gate
) {
  failures.push(`${files.functionMap}: v3.provider_action_gate owner must remain routecodex-v3-runtime`);
}
assertExactStrings(
  feature?.mainline_bindings,
  requiredV3Edges.map((edge) => edge.step_id),
  `${files.functionMap}: v3.provider_action_gate.mainline_bindings`,
);
assertIncludes(
  feature?.resource_bindings,
  ['v3.error.execution_decision', 'v3.error.provider_action_gate', 'v3.provider.health_state'],
  `${files.functionMap}: v3.provider_action_gate.resource_bindings`,
);
if (verification?.status !== 'source_active_live_verification_required') {
  failures.push(`${files.verificationMap}: v3.provider_action_gate status must retain pending live proof`);
}
assertExactStrings(
  verification?.mainline_bindings,
  requiredV3Edges.map((edge) => edge.step_id),
  `${files.verificationMap}: v3.provider_action_gate.mainline_bindings`,
);
assertIncludes(
  verification?.required_positive,
  [
    'Responses Relay provider-bound request compatibility and wire encoding failures enter the shared provider failure policy and typed Error05 action lane before retry or reselect.',
  ],
  `${files.verificationMap}: v3.provider_action_gate.required_positive`,
);
assertIncludes(
  verification?.contract,
  [files.manifest, files.resourceMap, files.functionMap, files.mainlineMap, files.wiki],
  `${files.verificationMap}: v3.provider_action_gate.contract`,
);
if (resource?.binding_status !== 'anchored') {
  failures.push(`${files.resourceMap}: V3 provider action gate resource must be anchored`);
}
if (
  resource?.resource_kind !== 'process_local_control_side_channel'
  || resource?.owner_crate !== 'routecodex-v3-runtime'
  || resource?.owner_node !== 'V3ProviderActionGateAdmission'
  || resource?.lifecycle !== 'v3.provider_action_gate.mainline'
  || v3Chain?.owner_feature_id !== 'v3.provider_action_gate'
  || manifest?.lifecycle_id !== 'v3.provider_action_gate.mainline'
  || manifest?.owner_feature !== 'v3.provider_action_gate'
) {
  failures.push(
    `${files.resourceMap} + ${files.mainlineMap} + ${files.manifest}: V3 lifecycle/chain/owner binding drift`,
  );
}
if (
  manifest?.downstream_projection?.owner_crate !== 'routecodex-v3-error'
  || manifest?.downstream_projection?.input_node !== 'V3Error05ExecutionDecision'
  || manifest?.downstream_projection?.output_node !== 'V3Error06ClientProjected'
  || manifest?.downstream_projection?.provider_action_gate_witness !== 'none'
) {
  failures.push(`${files.manifest}: downstream Error06 projection must remain routecodex-v3-error owned with no gate witness`);
}
assertIncludes(
  resource?.allowed_writers,
  [
    'V3ProviderActionGate::abandon_admission',
    'V3ProviderActionGate::commit_terminal_admission',
  ],
  `${files.resourceMap}: v3.error.provider_action_gate.allowed_writers`,
);
if (
  manifest?.admission_permit?.owner_type !== 'V3ProviderActionPermit'
  || manifest?.admission_permit?.wall_clock_expiry !== 'forbidden'
  || manifest?.admission_permit?.fresh_request_consumes_active_recovery_lane !== false
  || manifest?.admission_permit?.waiter_order !== 'fifo_ticket'
) {
  failures.push(
    `${files.manifest}: admission_permit must lock explicit ownership, no wall-clock expiry, FIFO, and fresh-request isolation`,
  );
}
if (Object.hasOwn(manifest, 'admission_lease')) {
  failures.push(`${files.manifest}: disproved admission_lease contract must be physically removed`);
}
assertIncludes(
  resource?.required_gates,
  [
    'npm run verify:v3-provider-action-gate',
    'npm run test:v3-provider-action-gate-red-fixtures',
    'npm run verify:v3-resource-map',
  ],
  `${files.resourceMap}: v3.error.provider_action_gate.required_gates`,
);
if (v2Manifest.status !== 'active' || manifest.status !== 'active') {
  failures.push('provider action gate V2/V3 manifests must both be active');
}
const v2WikiMermaid = extractSingleMermaidBlock(text.v2Wiki, files.v2Wiki);
const v3WikiMermaid = extractSingleMermaidBlock(text.wiki, files.wiki);
assertExactStrings(
  extractWikiStepIds(v2WikiMermaid, 'error-provider-action-gate-'),
  requiredV2Edges.map((edge) => edge.step_id),
  `${files.v2Wiki}: machine edge IDs`,
);
assertExactStrings(
  extractWikiStepIds(v3WikiMermaid, 'v3-provider-action-gate-'),
  requiredV3Edges.map((edge) => edge.step_id),
  `${files.wiki}: machine edge IDs`,
);
for (const [stepId, fromAlias, toAlias] of [
  ['error-provider-action-gate-01', 'E05', 'Failure'],
  ['error-provider-action-gate-02', 'Failure', 'Admission'],
  ['error-provider-action-gate-03', 'Admission', 'CommitRequest'],
  ['error-provider-action-gate-04', 'CommitRequest', 'Committed'],
  ['error-provider-action-gate-05', 'Admission', 'SuccessRequest'],
  ['error-provider-action-gate-06', 'SuccessRequest', 'SuccessCommitted'],
  ['error-provider-action-gate-07', 'Admission', 'AbandonRequest'],
  ['error-provider-action-gate-08', 'AbandonRequest', 'Abandoned'],
]) {
  assertWikiEdge(v2WikiMermaid, files.v2Wiki, stepId, fromAlias, toAlias);
}
for (const [stepId, fromAlias, toAlias] of [
  ['v3-provider-action-gate-01', 'Compat', 'E05'],
  ['v3-provider-action-gate-02', 'Wire', 'E05'],
  ['v3-provider-action-gate-03', 'E05', 'Witness'],
  ['v3-provider-action-gate-04', 'Witness', 'Gate'],
  ['v3-provider-action-gate-05', 'E05', 'TerminalAdmission'],
  ['v3-provider-action-gate-06', 'TerminalAdmission', 'TerminalCommit'],
  ['v3-provider-action-gate-07', 'Gate', 'Retry'],
  ['v3-provider-action-gate-08', 'Witness', 'Gate'],
  ['v3-provider-action-gate-09', 'Retry', 'Gate'],
  ['v3-provider-action-gate-10', 'Witness', 'Gate'],
  ['v3-provider-action-gate-11', 'Witness', 'Gate'],
  ['v3-provider-action-gate-12', 'Witness', 'Gate'],
  ['v3-provider-action-gate-13', 'Witness', 'Gate'],
  ['v3-provider-action-gate-14', 'E01', 'E05'],
  ['v3-provider-action-gate-15', 'E01', 'E05'],
  ['v3-provider-action-gate-16', 'E01', 'E05'],
  ['v3-provider-action-gate-17', 'E01', 'E05'],
  ['v3-provider-action-gate-18', 'E01', 'E05'],
  ['v3-provider-action-gate-19', 'Gate', 'Permit'],
  ['v3-provider-action-gate-20', 'Gate', 'Permit'],
  ['v3-provider-action-gate-21', 'Gate', 'Permit'],
  ['v3-provider-action-gate-22', 'Gate', 'Permit'],
  ['v3-provider-action-gate-23', 'Gate', 'Permit'],
  ['v3-provider-action-gate-24', 'Permit', 'AbandonRequest'],
  ['v3-provider-action-gate-25', 'Permit', 'AbandonRequest'],
  ['v3-provider-action-gate-26', 'Permit', 'AbandonRequest'],
  ['v3-provider-action-gate-27', 'Permit', 'AbandonRequest'],
  ['v3-provider-action-gate-28', 'Permit', 'AbandonRequest'],
  ['v3-provider-action-gate-29', 'Permit', 'AbandonRequest'],
  ['v3-provider-action-gate-30', 'Permit', 'AbandonRequest'],
  ['v3-provider-action-gate-31', 'Permit', 'AbandonRequest'],
  ['v3-provider-action-gate-32', 'AbandonRequest', 'Abandoned'],
  ['v3-provider-action-gate-33', 'Permit', 'SuccessObserved'],
  ['v3-provider-action-gate-34', 'SuccessObserved', 'SuccessRecorded'],
  ['v3-provider-action-gate-35', 'Permit', 'FailureObserved'],
  ['v3-provider-action-gate-36', 'Abandoned', 'FailureRecorded'],
  ['v3-provider-action-gate-37', 'Permit', 'SuccessObserved'],
  ['v3-provider-action-gate-38', 'SuccessObserved', 'SuccessRecorded'],
  ['v3-provider-action-gate-39', 'Permit', 'FailureObserved'],
  ['v3-provider-action-gate-40', 'Abandoned', 'FailureRecorded'],
  ['v3-provider-action-gate-41', 'Permit', 'SuccessObserved'],
  ['v3-provider-action-gate-42', 'SuccessObserved', 'SuccessRecorded'],
  ['v3-provider-action-gate-43', 'Permit', 'FailureObserved'],
  ['v3-provider-action-gate-44', 'Abandoned', 'FailureRecorded'],
  ['v3-provider-action-gate-45', 'Permit', 'SuccessRecorded'],
  ['v3-provider-action-gate-46', 'Permit', 'SuccessFinalize'],
  ['v3-provider-action-gate-47', 'SuccessFinalize', 'SuccessRecorded'],
  ['v3-provider-action-gate-48', 'ProviderRaw', 'ProviderCodec'],
  ['v3-provider-action-gate-49', 'ProviderCodec', 'ProviderOutcome'],
  ['v3-provider-action-gate-50', 'ProviderRaw', 'ProviderCodec'],
  ['v3-provider-action-gate-51', 'ProviderCodec', 'ProviderOutcome'],
]) {
  assertWikiEdge(v3WikiMermaid, files.wiki, stepId, fromAlias, toAlias);
}
if (/^\s*Committed\s*-->/mu.test(v2WikiMermaid)) {
  failures.push(`${files.v2Wiki}: terminal commit cannot claim a downstream machine edge`);
}
if (/^\s*TerminalCommit\s*-->/mu.test(v3WikiMermaid)) {
  failures.push(`${files.wiki}: terminal commit cannot claim a downstream machine edge`);
}

let packageJson = {};
try {
  packageJson = JSON.parse(text.packageJson);
} catch (error) {
  failures.push(`package.json: JSON parse failed: ${error.message}`);
}
const commands = {
  'test:v3-provider-action-gate': 'CARGO_NET_OFFLINE=true node scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-error && CARGO_NET_OFFLINE=true node scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --test provider_action_gate_contract -- --test-threads=1 --nocapture',
  'verify:v3-provider-action-gate': 'node scripts/architecture/verify-v3-provider-action-gate.mjs',
  'test:v3-provider-action-gate-red-fixtures': 'node scripts/tests/v3-provider-action-gate-red-fixtures.mjs',
};
for (const [name, command] of Object.entries(commands)) {
  if (packageJson.scripts?.[name] !== command) failures.push(`package.json: script ${name} must equal ${command}`);
}
for (const scriptName of ['verify:v3-architecture-docs', 'build:v3-cli']) {
  if (!String(packageJson.scripts?.[scriptName] || '').includes('npm run verify:v3-provider-action-gate')) {
    failures.push(`package.json: ${scriptName} must run npm run verify:v3-provider-action-gate`);
  }
}
for (const command of Object.keys(commands).map((name) => `npm run ${name}`)) {
  requireText(text.workflow, files.workflow, command);
}

if (failures.length) {
  console.error('[verify:v3-provider-action-gate] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-provider-action-gate] ok');
console.log(`- V2 required machine edges: ${requiredV2Edges.length}`);
console.log(`- V3 required machine edges: ${requiredV3Edges.length}`);
console.log('- every declared symbol exists and every caller body invokes its declared callee');
console.log('- V2/V3 map-manifest endpoints, status, symbols, files, and owner bindings are synchronized');
