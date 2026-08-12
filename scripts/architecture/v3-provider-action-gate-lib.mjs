// Provider-action-gate helper library: edge/symbol/function-body contract checks.
// Split from verify-v3-provider-action-gate.mjs to satisfy the v3-file-size
// ratchet. Helpers close over the gate context (root, failures).

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export function attachProviderActionGateHelpers(context) {
  const { root, failures, files } = context;

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



const requiredV3Edges = [
  {
    step_id: 'v3-provider-action-gate-01',
    from_node: 'ProviderReqCompat06ProviderCompat',
    to_node: 'V3Error05ExecutionDecision',
    caller_symbol: 'execute_v3_responses_relay_runtime_inner',
    caller_file: files.responsesInner,
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
    caller_file: files.responsesInner,
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
    caller_file: files.responsesInner,
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
    // openai_chat/gemini 已收敛到统一 relay 骨架：wait_for_error05_recovery 在骨架内。
    caller_symbol: 'execute_v3_relay_runtime_core',
    caller_file: files.relayCore,
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
    // gemini 已收敛到统一 relay 骨架（见 12）。
    caller_symbol: 'execute_v3_relay_runtime_core',
    caller_file: files.relayCore,
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
    // 共享 relay 失败处理（gemini/anthropic/openai_chat 收敛后统一在 relay_runtime_shared）。
    caller_symbol: 'handle_provider_failure',
    caller_file: files.relayShared,
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
    caller_file: files.responsesInner,
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
    // openai_chat/gemini 已收敛到统一 relay 骨架：admission.take_permit 在骨架内。
    caller_symbol: 'execute_v3_relay_runtime_core',
    caller_file: files.relayCore,
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
    caller_symbol: 'execute_v3_anthropic_relay_runtime_inner',
    caller_file: files.anthropic,
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
    caller_file: files.responsesInner,
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
    // openai_chat/gemini 已收敛到统一 relay 骨架：permit drop 在骨架内。
    caller_symbol: 'execute_v3_relay_runtime_core',
    caller_file: files.relayCore,
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
    caller_symbol: 'execute_v3_anthropic_relay_runtime_inner',
    caller_file: files.anthropic,
    callee_symbol: 'V3ProviderActionPermit::drop',
    callee_file: files.gate,
    call_witness: /\bdrop\s*\(\s*_?provider_action_permit\.take\(\)\s*\)/u,
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
    caller_file: files.responsesInner,
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
  return {
    abs,
    read,
    requireText,
    requireOccurrenceCount,
    parseYaml,
    asArray,
    stringSet,
    assertIncludes,
    assertExactStrings,
    simpleSymbol,
    escapeRegExp,
    extractWikiStepIds,
    assertWikiEdge,
    extractSingleMermaidBlock,
    assertRustTest,
    maskCommentsAndStrings,
    findFunctionBody,
    assertCallerInvokesCallee,
    requiredV3Edges,
  };
}
